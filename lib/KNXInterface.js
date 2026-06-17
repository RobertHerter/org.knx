'use strict';

const { EventEmitter } = require('events');
const knx = require('knx');
const PromiseQueue = require('promise-queue');
const util = require('util');

class KNXInterface extends EventEmitter {

  constructor(knxInterface) {
    super();

    // Setting object parameters from parameters from the interfacemanager
    this.name = knxInterface.interfaceName;
    this.ipAddress = knxInterface.interfaceIp;
    this.macAddress = knxInterface.interfaceMac;
    this.knxAddress = knxInterface.knxAddress;
    this.mode = knxInterface.mode || 'tunnel'; // 'tunnel' | 'router'
    this.multicastAddress = knxInterface.multicastAddress || '224.0.23.12';

    // KNX interface settings/variabeles
    this.isConnected = false; // Boolean to keep track of the connection status.
    this.isTimedOut = false; // Boolean to keep track of timeout events.
    this.knxDisconnectCount = 0;
    this._connGen = 0; // Incremented on each reconnect; guards stale-connection callbacks.

    this.knxCommunicationQueue = new PromiseQueue(1, 200);

    // Learnmode variables
    this.learnMode = false;
    this.knxEventCaptures = [];

    // Setup logging and binding for fucntions
    this.log = console.log.bind(this, (`[Interface: ${this.name}]`));

    // Object arrays with callbacks
    this.onKNXConnectionCallbacks = [];
    this.onKNXEventCallbacks = {};

    this.log(`Creating interface with IP ${this.ipAddress}`);
    this.createConnection();
  }

  // Function to create the KNX connection
  createConnection() {
    // The KNX tunnel connection itself through the knx library
    if (this.isConnected === true && !this.isTimedOut) return; // Skip re-initializing when already connected and healthy.
    const gen = ++this._connGen; // generation tag — stale-connection events are silently dropped
    try {
      const ipAddr = this.mode === 'router' ? this.multicastAddress : this.ipAddress;
      this.knxConnection = new knx.Connection({
        ipAddr, // Multicast address for router mode, unicast for tunnel mode
        ipPort: 3671, // Fixed and part of the KNXnet/IP protocol.
        physAddr: this.knxAddress, // KNX address obtained through interfacemanager
        forceTunneling: this.mode !== 'router', // Router mode uses multicast, no forced tunneling
        loglevel: 'info',
        manualConnect: true, // The connection should be only opened if it's going to be used.
        minimumDelay: 100, // This sets the timeout between messages in ms
        // Setup the handlers that the library will use to respond on emits from FSM.js
        suppress_ack_ldatareq: false,
        handlers: {
          connected: () => {
            if (this._connGen !== gen) return; // belongs to a superseded connection
            this.log('KNX Connected');
            // Change both connection booleans to their optimal state
            this.isConnected = true;
            this.isTimedOut = false;

            // Cancel pending disconnected notification — connection recovered quickly
            clearTimeout(this._disconnectNotifyTimer);

            // Stagger notifications so devices don't all read the KNX bus simultaneously,
            // which would flood the bus and risk triggering another disconnect.
            this.onKNXConnectionCallbacks.forEach((connCallback, index) => {
              setTimeout(() => {
                try {
                  connCallback('connected');
                } catch (error) {
                  this.log(error);
                }
              }, index * 100);
            });
          },
          disconnected: () => {
            if (this._connGen !== gen) return; // belongs to a superseded connection
            this.log('KNX Disconnected');
            this.isConnected = false;
            this.isTimedOut = false;
            this.knxCommunicationQueue = new PromiseQueue(1, 200);

            // Delay before marking devices unavailable to absorb brief interruptions.
            // If the connection recovers within 5 s, devices never see the drop.
            clearTimeout(this._disconnectNotifyTimer);
            this._disconnectNotifyTimer = setTimeout(() => {
              this.onKNXConnectionCallbacks.forEach((callback) => {
                try {
                  callback('disconnected');
                } catch (error) {
                  this.log(error);
                }
              });
            }, 5000);
          },
          event: (e, src, dest, val) => {
            if (this._connGen !== gen) return;
            this.onKNXEventListener(e, src, dest, val);
          },
          timeout: () => {
            if (this._connGen !== gen) return;
            this.isTimedOut = true;
            this.log('FSM timeout received');
          },
          error: (connstatus) => {
            if (this._connGen !== gen) return;
            this.log('Error from FSM:', connstatus);
          },
        },
      });
    } catch (error) {
      this.log('KNX lib error', error); // This should be able to catch the 'no valid ipv4 interfaces' error
    }
  }

  // ////////// KNX IP Interface and connection stuff ////////////

  // Function to (re)open the connection to the KNX network
  _connectKNX() {
    if (!this.knxConnection) return;
    if (this.isConnected === true) {
      this.log('Already connected');
      return;
    }
    // IpRoutingConnection.Connect() sets this.socket synchronously before bind completes.
    // If socket is already set, a bind is already in progress — don't create a second one.
    // (Multiple devices calling _connectKNX() on the same interface would otherwise each
    //  call Connect(), creating concurrent sockets on port 3671 and triggering EINVAL/EADDRINUSE.)
    if (this.knxConnection.socket) return;
    this.log('Trying to (re)connect');
    try {
      this.knxConnection.Connect();
      // The library sets socket synchronously in Connect() but only adds an error handler
      // inside the bind callback (which never fires when bind itself fails). Add one now so
      // a bind failure cannot become an unhandled 'error' event that crashes the process.
      if (this.knxConnection.socket) {
        this.knxConnection.socket.on('error', (err) => {
          this.log('KNX socket error:', err.message);
          this._reconnect();
        });
      }
    } catch (error) {
      this.log('KNX lib connect error', error);
    }
  }

  // Function to update the IP address if a change is detected by the interfacemanager.
  updateIP(newIPaddress) {
    if (this.mode === 'router') {
      this.log('Router mode: ignoring IP update to', newIPaddress);
      return;
    }
    if (newIPaddress === this.ipAddress) {
      this.log('IP has not changed, maintaining current connection');
    } else {
      this.log('Creating new KNX tunnel connection');
      this.ipAddress = newIPaddress;
      this._reconnect();
    }
  }

  // Override the KNX physical address (physAddr) and reconnect.
  setKNXAddress(newAddr) {
    if (!newAddr || newAddr === this.knxAddress) return;
    this.log(`Changing KNX address from ${this.knxAddress} to ${newAddr}`);
    this.knxAddress = newAddr;
    this._reconnect();
  }

  // Change the connection mode and reconnect.
  setMode(mode, multicastAddress) {
    const newMulticast = multicastAddress || '224.0.23.12';
    if (this.mode === mode && (mode !== 'router' || this.multicastAddress === newMulticast)) {
      return; // Nothing changed
    }
    this.log(`Switching mode from ${this.mode} to ${mode}`);
    this.mode = mode;
    this.multicastAddress = newMulticast;
    this._reconnect();
  }

  // Permanently shut down this interface (no reconnect).
  destroy() {
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._disconnectNotifyTimer);
    if (this.knxConnection) {
      const old = this.knxConnection;
      this.knxConnection = null;
      try { clearInterval(old.connecttimer); } catch (e) {}
      try { clearTimeout(old.idletimer); } catch (e) {}
      try { clearTimeout(old.disconnecttimer); } catch (e) {}
      try { clearTimeout(old.connstatetimer); } catch (e) {}
      try { clearTimeout(old.tunnelingAckTimer); } catch (e) {}
      this._disposeSocket(old.socket, old.localAddress);
    }
    this.isConnected = false;
  }

  // Safely disconnect and reconnect the KNX connection
  _reconnect() {
    this.isTimedOut = false;
    clearTimeout(this._disconnectNotifyTimer); // suppress spurious unavailable during deliberate reconnect
    clearTimeout(this._reconnectTimer); // cancel any already-scheduled reconnect (e.g. rapid double-call)

    // Tear down the existing connection completely.
    // We bypass the library's Disconnect() state machine because it can leave
    // FSM timers running that fire on the closed socket and produce
    // ERR_SOCKET_DGRAM_NOT_RUNNING warnings. Instead we clear every timer
    // we know about and close the socket directly.
    if (this.knxConnection) {
      const old = this.knxConnection;
      this.knxConnection = null;
      // Clear all FSM timers before touching the socket.
      try { clearInterval(old.connecttimer); } catch (e) {}
      try { clearTimeout(old.idletimer); } catch (e) {}
      try { clearTimeout(old.disconnecttimer); } catch (e) {}
      try { clearTimeout(old.connstatetimer); } catch (e) {}
      try { clearTimeout(old.tunnelingAckTimer); } catch (e) {}
      // Close the socket — no more inbound messages, no more sends.
      this._disposeSocket(old.socket, old.localAddress);
    }

    this.isConnected = false;

    // Wait 500ms for the OS to release any bound port before we rebind.
    this._reconnectTimer = setTimeout(() => {
      this.createConnection();
      this._connectKNX();
    }, 500);
  }

  // Close a routing socket, handling the case where it is still mid-bind.
  // If close() fails because the socket hasn't finished binding yet, we defer the close
  // until the 'listening' event fires and then drop multicast membership before closing,
  // so the OS releases the group membership before the new socket tries to join.
  _disposeSocket(socket, localAddress) {
    if (!socket) return;
    try {
      socket.close();
    } catch (e) {
      // Socket not yet running — close it once bind completes.
      socket.once('error', () => {}); // prevent crash if bind fails on this stale socket
      socket.once('listening', () => {
        if (this.mode === 'router') {
          try { socket.dropMembership(this.multicastAddress, localAddress); } catch (e2) {}
        }
        try { socket.close(); } catch (e2) {}
        this.isConnected = false; // undo the 'connected' event that fired for this stale socket
      });
    }
  }

  // Function which returns the connected (or last connected) IP Address
  getConnectedIPAddress() {
    return this.ipAddress;
  }

  // KNX connection listener. Stores the given callback
  onKNXConnectionListener(callback) {
    if (this.isConnected) {
      callback('connected');
    }
    this.onKNXConnectionCallbacks.push(callback); // list with KNX callback to update on connecting.
    // console.log('KNXConnection callback list updated');
  }

  removeKNXConnectionListener(callback) {
    this.onKNXConnectionCallbacks = this.onKNXConnectionCallbacks.filter((cb) => cb !== callback);
    // console.log('KNXConnection callback list updated');
  }

  // KNX busevent listener, callbacks are added per groupaddress
  addKNXEventListener(groupaddress, callback) {
    if (typeof groupaddress === 'string' && groupaddress !== '') {
      if (!this.onKNXEventCallbacks[groupaddress]) {
        this.onKNXEventCallbacks[groupaddress] = [callback];
      } else {
        this.onKNXEventCallbacks[groupaddress].push(callback);
      }
    }
  }

  // Removes all listeners attached the the provided callback
  removeKNXEventListener(groupaddress, callback) {
    if (typeof groupaddress === 'string' && groupaddress !== '') {
      if (this.onKNXEventCallbacks[groupaddress]) {
        this.onKNXEventCallbacks[groupaddress] = this.onKNXEventCallbacks[groupaddress]
          .filter((cb) => cb !== callback);
      }
    }
  }

  // KNX busevent listener, triggered when an KNX event occurs
  onKNXEventListener(event, source, destination, value) {
    // Emit the event, and if there is a callback for the destiniation addres call it.
    if (!destination) return;
    this.emit('knx_event', event, destination, value);
    if (this.onKNXEventCallbacks[destination] && (event === 'GroupValue_Write' || event === 'GroupValue_Response')) {
      this.onKNXEventCallbacks[destination].forEach((callback) => {
        if (!callback || typeof callback !== 'function') return;
        callback(destination, value);
      });
    }
    // If the learnmode is turned on, also store the event in de capture array.
    if (this.learnMode) {
      this.log('Pushing event to learn mode store');
      this.knxEventCaptures.push({
        event,
        destination,
        source,
        value,
      });
    }
  }

  // ////////// KNX Group Address Stuff ////////////

  // Write a groupadress with the given value and datapoint type
  async writeKNXGroupAddress(groupaddress, value, datapoint) {
    // Check if the groupadress is not empty
    if (groupaddress && groupaddress !== '') {
      if (this.isConnected === true && !this.isTimedOut) {
        // Only add the request in the queue when the connection is openend.
        this.log(`Writing ${value} to ${groupaddress}`);
        return this.knxCommunicationQueue.add(async () => {
          // Create a promisify function from the knx lib, then call it.
          // console.log('Writing', value, 'with dpt', datapoint, 'to', groupaddress);
          const writeAsync = util.promisify(this.knxConnection.write.bind(this.knxConnection));
          return writeAsync(groupaddress, value, datapoint);
        });
      }
      ++this.knxDisconnectCount;
      throw new Error('knx_no_connection');
    }
    throw new Error('knx_no_groupaddress');
  }

  // Function to read the value for the given groupadress
  async readKNXGroupAddress(groupaddress) {
    if (groupaddress && groupaddress !== '') {
      // Check if the groupadress is not empty
      if (this.isConnected === true && !this.isTimedOut) {
        return this.knxCommunicationQueue.add(async () => {
          // Only add the request in the queue when the connection is openend.
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`knx_read_timeout: ${groupaddress}`)), 3000);
            this.knxConnection.read(groupaddress, (src, data) => {
              clearTimeout(timeout);
              resolve(data);
            });
          });
        });
      }
      ++this.knxDisconnectCount;
      throw new Error('knx_no_connection');
    }
    throw new Error('knx_no_groupaddress');
  }

  // Run the learnmode for the given time.
  async learnModeSwitch(time) {
    this.knxEventCaptures = [];
    if (this.learnMode === true) throw new Error('already_learmode');
    this.learnMode = true; // start the learnmode

    await this._wait(time);
    this.learnMode = false;
    return this.filterKNXEvents(this.knxEventCaptures);
  }

  /*
    Async wait function
   */
  _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* Function to filter the captured events from the learnmode.
  Duplicate entries will be reduced to one entry, which will be counted.
  The list will then be sorted by event occurrence if possible.
  */
  filterKNXEvents(list) {
    const filterSet = new Set();
    const countObj = {};
    for (const obj of list) {
      if (filterSet.has(obj.destination)) {
        countObj[obj.destination]++;
      } else {
        countObj[obj.destination] = 1;
        filterSet.add(obj.destination);
      }
    }
    list = list.sort((a, b) => {
      return (countObj[b.destination] - countObj[a.destination]);
    });
    let filteredList = [];
    list.forEach((event) => {
      if (event.value.readUInt8() === 0 || event.value.readUInt8() === 1) {
        filteredList.push(event);
      }
    });
    filteredList = filteredList.filter((event, pos, arr) => {
      return arr.map((mapObj) => mapObj['destination'])
        .indexOf(event['destination']) === pos;
    });
    return filteredList;
  }

}

module.exports = KNXInterface;
