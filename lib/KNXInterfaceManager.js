'use strict';

const { EventEmitter } = require('events');
const dgram = require('dgram');
const ip = require('ip');
const KNXInterface = require('./KNXInterface');

class KNXInterfaceManager extends EventEmitter {

  constructor(localIP, homey) {
    super();

    this.homey = homey;

    this.log = console.log.bind(this, '[KNX interface manager]');
    this.errorLog = console.error.bind(this, '[KNX interface manager] ERROR:');

    // Used as mutex for checkKNXInterface (manual IP probe)
    this.searchRunning = false;

    this.KNXInterfaces = {};

    if (ip.isV4Format(localIP)) {
      this.localIPBuffer = ip.toBuffer(localIP);
      this._restoreSavedInterfaces();
    } else {
      this.errorLog('IP address is not a valid IPv4 format');
      return;
    }

    this.on('interface_found', (knxInterface) => {
      this.log('Current interfaces:', Object.values(this.KNXInterfaces).map((i) => i.name));
    });
  }

  // Restore interfaces saved from the previous session directly from settings — no UDP scan.
  _restoreSavedInterfaces() {
    const interfaces = this.homey.settings.get('interfaces') || [];
    let restored = 0;

    for (const savedInterface of interfaces) {
      if (!savedInterface || !savedInterface.mac) continue;
      if (this.KNXInterfaces[savedInterface.mac]) continue;

      const ifaceSettings = this._getInterfaceSetting(savedInterface.mac);

      if (ifaceSettings.mode === 'router') {
        const multicast = ifaceSettings.multicastAddress || '224.0.23.12';
        const name = ifaceSettings.name || savedInterface.name || `KNX Router (${multicast})`;
        this.KNXInterfaces[savedInterface.mac] = new KNXInterface({
          interfaceName: name,
          interfaceMac: savedInterface.mac,
          interfaceIp: multicast,
          knxAddress: ifaceSettings.knxAddress || savedInterface.knxAddress || '0.0.0',
          mode: 'router',
          multicastAddress: multicast,
        });
        this.emit('interface_found', this.KNXInterfaces[savedInterface.mac]);
        restored++;
      } else {
        const ipAddr = ifaceSettings.ipAddress || savedInterface.ip;
        if (ipAddr && ip.isV4Format(ipAddr)) {
          const name = ifaceSettings.name || savedInterface.name || `KNX Tunnel (${ipAddr})`;
          this.KNXInterfaces[savedInterface.mac] = new KNXInterface({
            interfaceName: name,
            interfaceMac: savedInterface.mac,
            interfaceIp: ipAddr,
            knxAddress: ifaceSettings.knxAddress || savedInterface.knxAddress || '0.0.0',
            mode: 'tunnel',
            multicastAddress: ifaceSettings.multicastAddress || savedInterface.multicastAddress || '224.0.23.12',
          });
          this.emit('interface_found', this.KNXInterfaces[savedInterface.mac]);
          restored++;
        }
      }
    }

    if (restored === 0) {
      this.emit('no_interfaces');
    }
  }

  destroy() {}

  /**
   * Removes an interface from memory and disconnects it.
   * Settings cleanup (interfaces / interfaceSettings) is done by the caller
   * (the settings page writes those directly before signalling this method).
   */
  deleteInterface(mac) {
    const iface = this.KNXInterfaces[mac];
    if (iface) {
      iface.destroy();
      delete this.KNXInterfaces[mac];
    }
  }

  // ////////// KNX IP Interfaces ////////////

  // This method returns a KNXinterface with matching MAC address.
  getKNXInterface(macAddress) {
    return this.KNXInterfaces[macAddress];
  }

  // Returns the single active KNX interface used by all devices.
  // Prefers the interface stored under the 'selectedInterface' setting;
  // falls back to the first available interface.
  getActiveInterface() {
    const selectedMac = this.homey.settings.get('selectedInterface');
    if (selectedMac && this.KNXInterfaces[selectedMac]) {
      return this.KNXInterfaces[selectedMac];
    }
    const interfaces = Object.values(this.KNXInterfaces);
    return interfaces.length > 0 ? interfaces[0] : null;
  }

  // Thins method returns the complete list with KNX Interfaces
  getKNXInterfaceList() {
    return this.KNXInterfaces;
  }

  /**
   * Returns a simplified list of KNX interfaces used to store interfaces in the settings
   *
   * @returns {{ip: *, name: *, mac: *}[]}
   */
  getSimpleInterfaceList() {
    return Object.values(this.KNXInterfaces).map((knxInterface) => {
      return {
        name: knxInterface.name,
        mac: knxInterface.macAddress,
        ip: knxInterface.ipAddress,
        knxAddress: knxInterface.knxAddress,
        mode: knxInterface.mode || 'tunnel',
        multicastAddress: knxInterface.multicastAddress || '224.0.23.12',
      };
    });
  }

  /**
   * Creates a router-mode KNXInterface identified by the given multicast address.
   * A deterministic synthetic MAC is derived from the multicast address so the
   * interface survives app restarts without requiring a UDP discovery.
   *
   * Pass { persist: false } during pairing to add the interface to memory only —
   * no settings are written and no 'interface_found' is emitted.  Call
   * persistInterface(mac) when the user actually selects the interface.
   */
  addRouterInterface(multicastAddress, { persist = true } = {}) {
    const normalAddr = multicastAddress || '224.0.23.12';
    const mac = 'router' + normalAddr.replace(/\./g, '');

    if (this.KNXInterfaces[mac]) {
      return this.KNXInterfaces[mac];
    }

    this.KNXInterfaces[mac] = new KNXInterface({
      interfaceName: `KNX Router (${normalAddr})`,
      interfaceMac: mac,
      interfaceIp: normalAddr,
      knxAddress: '0.0.0',
      mode: 'router',
      multicastAddress: normalAddr,
    });

    if (persist) {
      const settings = this.homey.settings.get('interfaceSettings') || {};
      settings[mac] = { mode: 'router', multicastAddress: normalAddr };
      this.homey.settings.set('interfaceSettings', settings);
      this.homey.settings.set('interfaces', this.getSimpleInterfaceList());
      this.emit('interface_found', this.KNXInterfaces[mac]);
    }

    return this.KNXInterfaces[mac];
  }

  /**
   * Removes all interfaces except the one with the given MAC from both memory
   * and settings.  Call this before persistInterface() to enforce the
   * single-gateway model: switching from router to tunnel (or vice-versa)
   * cleanly replaces the old gateway instead of leaving two entries.
   */
  removeOtherInterfaces(keepMac) {
    const toRemove = Object.keys(this.KNXInterfaces).filter((m) => m !== keepMac);
    for (const mac of toRemove) {
      this.deleteInterface(mac);
    }

    if (toRemove.length > 0) {
      // Remove stale interfaceSettings entries
      const ifaceSettings = this.homey.settings.get('interfaceSettings') || {};
      let changed = false;
      for (const mac of toRemove) {
        if (mac in ifaceSettings) {
          delete ifaceSettings[mac];
          changed = true;
        }
      }
      if (changed) {
        this.homey.settings.set('interfaceSettings', ifaceSettings);
      }
      // Refresh the interfaces snapshot
      this.homey.settings.set('interfaces', this.getSimpleInterfaceList());
    }
  }

  /**
   * Persists an in-memory interface to settings and emits 'interface_found'.
   * Called when the user selects an interface that was only probed (not persisted)
   * during the pairing flow.  Safe to call on already-persisted interfaces.
   */
  persistInterface(mac) {
    const iface = this.KNXInterfaces[mac];
    if (!iface) return;

    const settings = this.homey.settings.get('interfaceSettings') || {};
    if (!settings[mac]) {
      settings[mac] = {
        mode: iface.mode || 'tunnel',
        multicastAddress: iface.multicastAddress || '224.0.23.12',
      };
      this.homey.settings.set('interfaceSettings', settings);
      this.homey.settings.set('interfaces', this.getSimpleInterfaceList());
      this.emit('interface_found', iface);
    }
  }

  /**
   * Returns the list of interfaces enriched with their connection mode settings,
   * used by the app settings page.
   */
  getInterfacesWithSettings() {
    return Object.values(this.KNXInterfaces).map((iface) => ({
      name: iface.name,
      mac: iface.macAddress,
      ip: iface.ipAddress,
      knxAddress: iface.knxAddress,
      mode: iface.mode || 'tunnel',
      multicastAddress: iface.multicastAddress || '224.0.23.12',
      isConnected: iface.isConnected,
    }));
  }

  /**
   * Returns the stored per-interface settings for a given MAC address.
   * Looks up both under the original mac and any alias stored in macAliases.
   */
  _getInterfaceSetting(mac) {
    const aliases = this.homey.settings.get('macAliases') || {};
    const settings = this.homey.settings.get('interfaceSettings') || {};
    const effectiveMac = aliases[mac] || mac;
    return {
      name: null,
      mode: 'tunnel',
      multicastAddress: '224.0.23.12',
      knxAddress: null,
      ipAddress: null,
      ...settings[effectiveMac],
    };
  }

  /**
   * Persists a full interface config change and applies it immediately.
   */
  setInterfaceMode(mac, mode, multicastAddress, knxAddress, ipAddress) {
    const settings = this.homey.settings.get('interfaceSettings') || {};
    settings[mac] = {
      mode,
      multicastAddress: multicastAddress || '224.0.23.12',
      knxAddress: knxAddress || null,
      ipAddress: ipAddress || null,
    };
    this.homey.settings.set('interfaceSettings', settings);

    const iface = this.KNXInterfaces[mac];
    if (iface) {
      iface.setMode(mode, multicastAddress);
      if (knxAddress) iface.setKNXAddress(knxAddress);
      if (ipAddress) iface.updateIP(ipAddress);
    }
  }

  /**
   * Re-applies all stored interface settings to running interfaces.
   * Called when the settings page writes a change via Homey.set().
   */
  applyInterfaceSettings() {
    const settings = this.homey.settings.get('interfaceSettings') || {};
    for (const [mac, config] of Object.entries(settings)) {
      const iface = this.KNXInterfaces[mac];
      if (iface) {
        if (config.name) iface.name = config.name;
        iface.setMode(config.mode, config.multicastAddress);
        if (config.knxAddress) iface.setKNXAddress(config.knxAddress);
        if (config.ipAddress) iface.updateIP(config.ipAddress);
      }
    }
  }

  /**
   * Re-applies all MAC aliases: renames interfaces in KNXInterfaces if needed.
   * Called when the settings page writes a change to 'macAliases'.
   */
  applyMacAliases() {
    const aliases = this.homey.settings.get('macAliases') || {};
    for (const [originalMac, customMac] of Object.entries(aliases)) {
      if (this.KNXInterfaces[originalMac] && !this.KNXInterfaces[customMac]) {
        this._doRename(originalMac, customMac);
      }
    }
  }

  /**
   * Renames an interface's key in KNXInterfaces, moves its interfaceSettings entry,
   * and updates the interfaces snapshot.  Does NOT write macAliases — that is the
   * caller's responsibility so we avoid triggering a settings change loop.
   */
  _doRename(oldMac, newMac) {
    const iface = this.KNXInterfaces[oldMac];
    if (!iface || this.KNXInterfaces[newMac]) return;

    this.log(`Renaming interface ${oldMac} → ${newMac}`);
    iface.macAddress = newMac;
    this.KNXInterfaces[newMac] = iface;
    delete this.KNXInterfaces[oldMac];

    // Move the interfaceSettings entry to the new key
    const settings = this.homey.settings.get('interfaceSettings') || {};
    if (settings[oldMac]) {
      settings[newMac] = settings[oldMac];
      delete settings[oldMac];
      this.homey.settings.set('interfaceSettings', settings);
    }

    // Refresh the interfaces snapshot so getSimpleInterfaceList() is up to date
    this.homey.settings.set('interfaces', this.getSimpleInterfaceList());
  }

  // Check if a given IP is a KNX IP Interface
  async discoverKNXInterfaceOnIP(ipAddress) {
    // Check if the given address is a valid IPv4 address
    if (!ip.isV4Format(ipAddress)) {
      throw new Error('invalid_ip');
    }
    return this.checkKNXInterface(ipAddress);
  }

  // Let the defined KNX Interface open the tunnel connection to the KNX network
  connectInterface(macAddress) {
    this.KNXInterfaces[macAddress]._connectKNX();
  }

  // Parse the received response for valid KNX IP data
  parseKNXResponse(inBuffer) {
    // Parse the first 2 bytes to check if it's KNXnet/IP traffic
    if (inBuffer[0] === 0x06 && inBuffer[1] === 0x10) {
      // Start checking the service types. Can be converted to switch case?
      // Search response
      if (inBuffer.readUInt16BE(2) === 0x202) {
        // Obtain and parse the IP address from the interface
        const interfaceIpRaw = inBuffer.readUInt32LE(8);

        /* eslint-disable max-len */
        const interfaceIp = `${(interfaceIpRaw & 0xff).toString()}.${((interfaceIpRaw >> 8) & 0xff).toString()}.${((interfaceIpRaw >> 16) & 0xff).toString()}.${((interfaceIpRaw >> 24) & 0xff).toString()}`;
        /* eslint-enable */

        // Obtain and parse the KNX topology address from the interface
        const knxAddressRaw = inBuffer.readUInt16BE(18);
        const knxAddress = `${((knxAddressRaw & 0xf000) >> 12).toString()}.${((knxAddressRaw & 0x0f00) >> 8).toString()
        }.${(knxAddressRaw & 0xff).toString()}`;
        const interfaceMac = inBuffer.toString('hex', 32, 38); // Grab the macaddress bytes
        const interfaceName = inBuffer.toString('utf-8', 38, 68).replace(/\0[\s\S]*$/g, ''); // Read the fixed 30 bytes device description

        // Multicast address reported by the device (bytes 28-31 in DIB_DEVICE_INFO).
        // A value of 0.0.0.0 means the device uses the KNX default multicast address.
        const mcastRaw = inBuffer.readUInt32LE(28);
        /* eslint-disable max-len */
        const deviceMulticast = mcastRaw === 0 ? '224.0.23.12' : `${(mcastRaw & 0xff).toString()}.${((mcastRaw >> 8) & 0xff).toString()}.${((mcastRaw >> 16) & 0xff).toString()}.${((mcastRaw >> 24) & 0xff).toString()}`;
        /* eslint-enable */

        // DIB_SUPP_SVC_FAMILIES starts immediately after DIB_DEVICE_INFO (offset 68).
        // Service family 0x05 (Routing) is only present in KNX IP Routers.
        let supportsRouting = false;
        if (inBuffer.length > 69 && inBuffer[69] === 0x02) {
          const svcLen = inBuffer[68];
          for (let i = 70; i < 68 + svcLen && i < inBuffer.length; i += 2) {
            if (inBuffer[i] === 0x05) { supportsRouting = true; break; }
          }
        }

        // this.log('Found', interfaceName, '@ IP:' + interfaceIp, 'with KNX address:', knxAddress);
        return {
          type: 0x202,
          interfaceName,
          interfaceIp,
          interfaceMac,
          knxAddress,
          deviceMulticast,
          supportsRouting,
        }; // Return an object with all found values
      }

      // Description response
      if (inBuffer.readUInt16BE(2) === 0x204) {
        // Obtain and parse the KNX topology Address
        const knxAddressRaw = inBuffer.readUInt16BE(10);
        const knxAddress = `${((knxAddressRaw & 0xf000) >> 12).toString()}.${((knxAddressRaw & 0x0f00) >> 8).toString()
        }.${(knxAddressRaw & 0xff).toString()}`;
        const interfaceMac = inBuffer.toString('hex', 24, 30); // Grab the macaddress bytes
        const interfaceName = inBuffer.toString('utf-8', 30, 60).replace(/\0[\s\S]*$/g, ''); // Read the fixed 30 bytes device description

        // Multicast address (bytes 20-23 in DIB_DEVICE_INFO for description response).
        const mcastRaw = inBuffer.readUInt32LE(20);
        /* eslint-disable max-len */
        const deviceMulticast = mcastRaw === 0 ? '224.0.23.12' : `${(mcastRaw & 0xff).toString()}.${((mcastRaw >> 8) & 0xff).toString()}.${((mcastRaw >> 16) & 0xff).toString()}.${((mcastRaw >> 24) & 0xff).toString()}`;
        /* eslint-enable */

        // DIB_SUPP_SVC_FAMILIES starts at offset 60 in description response.
        let supportsRouting = false;
        if (inBuffer.length > 61 && inBuffer[61] === 0x02) {
          const svcLen = inBuffer[60];
          for (let i = 62; i < 60 + svcLen && i < inBuffer.length; i += 2) {
            if (inBuffer[i] === 0x05) { supportsRouting = true; break; }
          }
        }

        // this.log('Found', interfaceName, ' with KNX address:', knxAddress);
        return {
          type: 0x204,
          interfaceName,
          interfaceMac,
          knxAddress,
          deviceMulticast,
          supportsRouting,
        }; // Return an object with all found values
      }
      // Connection response
      if (inBuffer.readUInt16BE(2) === 0x206) {
        // Obtain the communictionchannel and the connection result
        const commChannel = inBuffer[6];// .readUInt16BE();
        const connectionResult = inBuffer[7];
        return { type: 0x206, commChannel, connectionResult };
      }
      // ConnectionState Response
      if (inBuffer.readUInt16BE(2) === 0x208) {
        const commChannel = inBuffer[6];
        return { type: 0x208, commChannel };
      }
      // Disconnect response
      if (inBuffer.readUInt16BE(2) === 0x209) {
        this.log('KNX connection disconnected');
        return { type: 0x0209 };
      }
    }
    // Non-KNX UDP packets are silently ignored to avoid log spam on noisy networks
    return null;
  }

  async checkKNXInterface(ipAddress) {
    /* The correct flow to check if a given IP belongs to a KNX IP interface is:
    - Send an connection request. If this gets accepted it's certainly a KNX IP interface
    - Send the description request  to obtain the device information
    These actions mimics the traffic that ETS uses to check a IP interface
    */
    if (this.searchRunning === false) {
      this.log('Checking if', ipAddress, 'is a KNX IP interface');
      this.searchRunning = true;

      const knxIPPort = 3671; // Default KNX IP port, rarely changed
      const bufferByteLocalIP = this.localIPBuffer; // Grab the local IP address
      const bufferByteConnectionPort = Buffer.from([0x8F, 0x67]); // port 36711
      const bufferByteDevicePort = Buffer.from([0x8F, 0x68]); // port 36712

      // KNX header for connect request, 8 octets, IPV4
      const knxConnectRequest = Buffer.concat(
        [Buffer.from([0x06, 0x10, 0x02, 0x05, 0x00, 0x1a, 0x08, 0x01]),
          bufferByteLocalIP, // IP for HPAI discovery
          bufferByteConnectionPort, // Port for HPAI discovery
          Buffer.from([0x08, 0x01]), // 8 octets, IPV4
          bufferByteLocalIP, // IP for HPAI data endpoint
          bufferByteDevicePort, // Port for HPAI data endpoint
          // 4octets, Tunnel connection, tunnel linklayer, 00 reserved
          Buffer.from([0x04, 0x04, 0x02, 0x00])],
      );

      const knxDeviceInfoRequest = Buffer.concat(
        [Buffer.from([0x06, 0x10, 0x02, 0x03, 0x00, 0x0e, 0x08, 0x01]), // KNX header
          bufferByteLocalIP,
          bufferByteConnectionPort],
      );

      const udpSocket = dgram.createSocket('udp4'); // Create the socket connections

      return new Promise((resolve, reject) => {
        let interfaceFound = false;

        udpSocket
          .on('error', (err) => {
            // If the udp server errors, close the connection
            console.error('UDP server error', err.stack);
            try {
              udpSocket.close();
            } catch (e) {
              // socket may already be closed
            }
            this.searchRunning = false;
            reject(err);
          })
          .on('message', (msg, rinfo) => {
            const commResult = this.parseKNXResponse(msg);
            if (!commResult) return null; // Skip non-KNX messages, keep listening

            if (commResult.type === 0x206) {
              // console.log('Received connection response, now sending description request');
              udpSocket.send(knxDeviceInfoRequest, knxIPPort, ipAddress, (err, bytes) => {
                if (err) {
                  try {
                    udpSocket.close();
                  } catch (e) {
                    // socket may already be closed
                  }
                  this.searchRunning = false;
                  reject(err);
                }
              });
            } else if (commResult.type === 0x209) {
              // console.log('Closing connection');
              try {
                udpSocket.close();
              } catch (e) {
                // socket may already be closed
              }
            } else if (commResult.type === 0x204) {
              // console.log('Received description response');
              const knxInterface = {
                interfaceName: commResult.interfaceName,
                interfaceIp: ipAddress,
                interfaceMac: commResult.interfaceMac,
                knxAddress: commResult.knxAddress,
                deviceMulticast: commResult.deviceMulticast,
                supportsRouting: commResult.supportsRouting,
              };

              try {
                udpSocket.close();
              } catch (e) {
                // socket may already be closed
              }
              interfaceFound = true;
              this.searchRunning = false;

              try {
                // Update existing interface or create a new one
                const rawSettings = this.homey.settings.get('interfaceSettings') || {};
                const ifaceSettings = this._getInterfaceSetting(knxInterface.interfaceMac);
                const aliases = this.homey.settings.get('macAliases') || {};
                const effectiveMac = aliases[knxInterface.interfaceMac] || knxInterface.interfaceMac;
                if (this.KNXInterfaces[effectiveMac]) {
                  if (!ifaceSettings.ipAddress) {
                    this.KNXInterfaces[effectiveMac].updateIP(knxInterface.interfaceIp);
                  }
                } else {
                  const hasExplicitMode = !!(rawSettings[effectiveMac] && rawSettings[effectiveMac].mode);
                  const mode = hasExplicitMode ? ifaceSettings.mode : 'tunnel';
                  const multicastAddress = hasExplicitMode
                    ? (ifaceSettings.multicastAddress || '224.0.23.12')
                    : (knxInterface.deviceMulticast || '224.0.23.12');
                  this.KNXInterfaces[effectiveMac] = new KNXInterface({
                    ...knxInterface,
                    interfaceMac: effectiveMac,
                    mode,
                    multicastAddress,
                    knxAddress: ifaceSettings.knxAddress || knxInterface.knxAddress,
                    interfaceIp: ifaceSettings.ipAddress || knxInterface.interfaceIp,
                  });
                }
                const interfaces = this.getSimpleInterfaceList();
                this.homey.settings.set('interfaces', interfaces);
                this.emit('interface_found', this.KNXInterfaces[effectiveMac]);
                return resolve(this.KNXInterfaces[effectiveMac]);
              } catch (err) {
                this.log('Creating IP interface instance failed:', err);
                return reject(err);
              }
            }
            return null;
          })
          .on('listening', () => {
            udpSocket.send(knxConnectRequest, knxIPPort, ipAddress, (err, bytes) => {
              if (err) {
                try {
                  udpSocket.close();
                } catch (e) {
                  // socket may already be closed
                }
                this.searchRunning = false;
                return reject(err);
              }
              return null;
            });
          })
          .bind(36711);

        setTimeout(() => {
          if (!interfaceFound) {
            try {
              udpSocket.close();
            } catch (error) {
              // socket may already be closed
            }
            this.searchRunning = false;
            reject(new Error('interface_not_found'));
          }
        }, 5 * 1000); // 5 second timeout
      });
    }
    throw new Error('search_already_running');
  }

}

module.exports = KNXInterfaceManager;
