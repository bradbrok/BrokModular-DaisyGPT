// WebUSB DFU (Device Firmware Upgrade) for Daisy
// Based on electro-smith/Programmer (MIT License)
// Reference: USB DFU 1.1 specification

const DFU_DETACH    = 0x00;
const DFU_DNLOAD    = 0x01;
const DFU_UPLOAD    = 0x02;
const DFU_GETSTATUS = 0x03;
const DFU_CLRSTATUS = 0x04;
const DFU_GETSTATE  = 0x05;
const DFU_ABORT     = 0x06;

const DFU_STATUS = {
  OK:                 0x00,
  errTARGET:          0x01,
  errFILE:            0x02,
  errWRITE:           0x03,
  errERASE:           0x04,
  errCHECK_ERASED:    0x05,
  errPROG:            0x06,
  errVERIFY:          0x07,
  errADDRESS:        0x08,
  errNOTDONE:        0x09,
  errFIRMWARE:       0x0A,
  errVENDOR:         0x0B,
  errUSBR:           0x0C,
  errPOR:            0x0D,
  errUNKNOWN:        0x0E,
  errSTALLEDPKT:     0x0F,
};

const DFU_STATE = {
  appIDLE:                0,
  appDETACH:              1,
  dfuIDLE:                2,
  dfuDNLOAD_SYNC:         3,
  dfuDNBUSY:              4,
  dfuDNLOAD_IDLE:         5,
  dfuMANIFEST_SYNC:       6,
  dfuMANIFEST:            7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuUPLOAD_IDLE:         9,
  dfuERROR:               10,
};

// STM32 DFU specific
const SET_ADDRESS = 0x21;
const ERASE_PAGE  = 0x41;

// Daisy Seed STM32H750 memory map
const FLASH_BASE = 0x08000000;
const QSPI_BASE  = 0x90000000;

export class DaisyDFU {
  constructor() {
    this.device = null;
    this.interfaceNumber = 0;
    this.transferSize = 2048;
    this.onProgress = null;
    this.onLog = null;
  }

  log(msg) {
    if (this.onLog) this.onLog(msg);
  }

  async requestDevice() {
    // STM32 DFU mode VID:PID
    const filters = [
      { vendorId: 0x0483, productId: 0xDF11 },  // STMicroelectronics DFU
    ];

    try {
      this.device = await navigator.usb.requestDevice({ filters });
      this.log(`Device found: ${this.device.productName || 'STM32 DFU'}`);
      return true;
    } catch (err) {
      if (err.name === 'NotFoundError') {
        this.log('No DFU device selected. Put Daisy in DFU mode: hold BOOT, tap RESET');
      } else {
        this.log(`USB error: ${err.message}`);
      }
      return false;
    }
  }

  async open() {
    await this.device.open();

    // Find DFU interface
    const config = this.device.configuration;
    if (!config) {
      await this.device.selectConfiguration(1);
    }

    // Collect all DFU alternate settings so we can pick the right one for the target memory
    this.alternates = [];
    for (const iface of this.device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        // DFU class = 0xFE, subclass = 0x01
        if (alt.interfaceClass === 0xFE && alt.interfaceSubclass === 0x01) {
          this.interfaceNumber = iface.interfaceNumber;
          this.alternates.push({
            interfaceNumber: iface.interfaceNumber,
            alternateSetting: alt.alternateSetting,
            name: alt.interfaceName || '',
          });
        }
      }
    }

    await this.device.claimInterface(this.interfaceNumber);
    this.log(`Claimed interface ${this.interfaceNumber}`);
  }

  async selectAlternateForAddress(address) {
    // STM32 DFU bootloader exposes different alt settings for different memories.
    // Try to match by interface name string (e.g., contains "External" or the address).
    // Fallback: alt 0 = internal flash, alt 1 = external QSPI flash.
    const isQSPI = address >= QSPI_BASE;

    for (const alt of this.alternates) {
      const name = alt.name.toLowerCase();
      if (isQSPI && (name.includes('external') || name.includes('qspi') || name.includes('0x90'))) {
        await this.device.selectAlternateInterface(this.interfaceNumber, alt.alternateSetting);
        this.log(`Selected alternate ${alt.alternateSetting}: ${alt.name}`);
        return;
      }
      if (!isQSPI && (name.includes('internal') || name.includes('0x08'))) {
        await this.device.selectAlternateInterface(this.interfaceNumber, alt.alternateSetting);
        this.log(`Selected alternate ${alt.alternateSetting}: ${alt.name}`);
        return;
      }
    }

    // Fallback: alt 0 = internal, alt 1 = external
    const fallbackAlt = isQSPI ? 1 : 0;
    if (this.alternates.length > fallbackAlt) {
      await this.device.selectAlternateInterface(this.interfaceNumber, this.alternates[fallbackAlt].alternateSetting);
      this.log(`Selected alternate ${fallbackAlt} (fallback for ${isQSPI ? 'QSPI' : 'internal'} flash)`);
    }
  }

  async getStatus() {
    const result = await this.device.controlTransferIn({
      requestType: 'class',
      recipient: 'interface',
      request: DFU_GETSTATUS,
      value: 0,
      index: this.interfaceNumber,
    }, 6);

    if (result.status !== 'ok') {
      throw new Error(`GET_STATUS transfer failed: ${result.status}`);
    }

    const d = result.data;
    const raw = [];
    for (let i = 0; i < d.byteLength; i++) raw.push(d.getUint8(i).toString(16).padStart(2, '0'));
    if (this.onLog) this.onLog(`GET_STATUS raw[${d.byteLength}]: ${raw.join(' ')}`);

    return {
      status: d.getUint8(0),
      pollTimeout: d.getUint8(1) | (d.getUint8(2) << 8) | (d.getUint8(3) << 16),
      state: d.getUint8(4),
      string: d.getUint8(5),
    };
  }

  async clearStatus() {
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: DFU_CLRSTATUS,
      value: 0,
      index: this.interfaceNumber,
    });
  }

  async waitForState(targetState, maxRetries = 100) {
    for (let i = 0; i < maxRetries; i++) {
      const status = await this.getStatus();
      if (status.state === targetState) return status;
      if (status.state === DFU_STATE.dfuERROR) {
        await this.clearStatus();
        throw new Error(`DFU error: status ${status.status}`);
      }
      if (status.pollTimeout > 0) {
        await this._sleep(status.pollTimeout);
      }
    }
    throw new Error(`Timeout waiting for DFU state ${targetState}`);
  }

  async download(blockNum, data) {
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: DFU_DNLOAD,
      value: blockNum,
      index: this.interfaceNumber,
    }, data);
  }

  async setAddress(address) {
    const data = new Uint8Array(5);
    data[0] = SET_ADDRESS;
    data[1] = address & 0xFF;
    data[2] = (address >> 8) & 0xFF;
    data[3] = (address >> 16) & 0xFF;
    data[4] = (address >> 24) & 0xFF;

    await this.download(0, data);
    await this.waitForState(DFU_STATE.dfuDNLOAD_IDLE);
  }

  async eraseSector(address, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const data = new Uint8Array(5);
      data[0] = ERASE_PAGE;
      data[1] = address & 0xFF;
      data[2] = (address >> 8) & 0xFF;
      data[3] = (address >> 16) & 0xFF;
      data[4] = (address >> 24) & 0xFF;

      await this.download(0, data);

      // QSPI erase can take significantly longer than internal flash
      const isQSPI = address >= QSPI_BASE;
      const maxPolls = isQSPI ? 200 : 100;
      const minDelay = isQSPI ? 200 : 100;

      let status;
      let success = false;
      for (let i = 0; i < maxPolls; i++) {
        status = await this.getStatus();
        if (status.state === DFU_STATE.dfuDNLOAD_IDLE) {
          success = true;
          break;
        }
        if (status.state === DFU_STATE.dfuERROR) {
          await this.clearStatus();
          break;
        }
        await this._sleep(Math.max(status.pollTimeout, minDelay));
      }

      if (success) return;

      if (attempt < retries - 1) {
        this.log(`Erase failed at 0x${address.toString(16)}, retrying (${attempt + 1}/${retries})...`);
        // Reset to idle state before retry
        try {
          await this.device.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: DFU_ABORT,
            value: 0,
            index: this.interfaceNumber,
          });
          await this._sleep(500);
          const st = await this.getStatus();
          if (st.state === DFU_STATE.dfuERROR) await this.clearStatus();
        } catch (e) {
          // ignore recovery errors
        }
      }
    }

    throw new Error(`Erase error at 0x${address.toString(16)} after ${retries} attempts`);
  }

  async massErase() {
    this.log('Mass erase...');
    const data = new Uint8Array([0x41]);
    await this.download(0, data);

    for (let i = 0; i < 200; i++) {
      const status = await this.getStatus();
      if (status.state === DFU_STATE.dfuDNLOAD_IDLE) {
        this.log('Mass erase complete');
        return;
      }
      if (status.state === DFU_STATE.dfuERROR) {
        await this.clearStatus();
        throw new Error('Mass erase failed');
      }
      await this._sleep(500);
    }
    throw new Error('Mass erase timeout');
  }

  async flash(firmware, baseAddress = FLASH_BASE) {
    if (!this.device) throw new Error('No device connected');

    const totalBytes = firmware.byteLength;
    let bytesWritten = 0;
    const blockSize = this.transferSize;

    this.log(`Flashing ${totalBytes} bytes to 0x${baseAddress.toString(16)}...`);

    // Force device to a known state: abort any pending operation, clear errors
    try {
      await this.device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: DFU_ABORT,
        value: 0,
        index: this.interfaceNumber,
      });
    } catch (e) { /* ignore */ }
    await this._sleep(100);

    // Clear any error state and get to dfuIDLE
    let status;
    for (let i = 0; i < 5; i++) {
      status = await this.getStatus();
      this.log(`DFU state: ${status.state}, status: ${status.status}`);
      if (status.state === DFU_STATE.dfuIDLE) break;
      if (status.state === DFU_STATE.dfuERROR) {
        await this.clearStatus();
        continue;
      }
      // For any other state, try abort
      await this.device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: DFU_ABORT,
        value: 0,
        index: this.interfaceNumber,
      });
      await this._sleep(100);
    }
    if (!status || status.state !== DFU_STATE.dfuIDLE) {
      throw new Error(`Cannot reach dfuIDLE (state ${status ? status.state : 'unknown'})`);
    }

    // Erase sectors that will be written
    const sectorSize = 0x20000; // 128KB for STM32H750 internal flash
    const startSector = baseAddress;
    const endSector = baseAddress + totalBytes;
    for (let addr = startSector; addr < endSector; addr += sectorSize) {
      this.log(`Erasing sector at 0x${addr.toString(16)}...`);
      await this.eraseSector(addr);
    }
    this.log('Erase complete, writing...');

    // Set start address
    await this.setAddress(baseAddress);

    // Write data in blocks
    let blockNum = 2;
    for (let offset = 0; offset < totalBytes; offset += blockSize) {
      const end = Math.min(offset + blockSize, totalBytes);
      const chunk = new Uint8Array(firmware.slice(offset, end));

      await this.download(blockNum, chunk);

      // STM32 DFU: DNLOAD → dfuDNLOAD_SYNC → (getStatus) → dfuDNBUSY → (getStatus) → dfuDNLOAD_IDLE
      status = await this.getStatus();
      // Handle DNLOAD_SYNC: need another getStatus to trigger programming
      if (status.state === DFU_STATE.dfuDNLOAD_SYNC) {
        status = await this.getStatus();
      }
      if (status.state === DFU_STATE.dfuDNBUSY) {
        await this._sleep(status.pollTimeout || 10);
        status = await this.getStatus();
      }

      if (status.state !== DFU_STATE.dfuDNLOAD_IDLE) {
        throw new Error(`Write failed at offset ${offset}: state ${status.state}`);
      }

      bytesWritten += chunk.byteLength;
      blockNum++;

      if (this.onProgress) {
        this.onProgress({
          phase: 'write',
          current: bytesWritten,
          total: totalBytes,
          percent: Math.round((bytesWritten / totalBytes) * 100),
        });
      }
    }

    this.log(`Writing done, manifesting...`);

    // Send zero-length download to signal end
    await this.download(0, new ArrayBuffer(0));
    try {
      status = await this.getStatus();
      // Wait for manifest if needed
      if (status.state === DFU_STATE.dfuMANIFEST_SYNC || status.state === DFU_STATE.dfuMANIFEST) {
        await this._sleep(status.pollTimeout || 100);
        try { await this.getStatus(); } catch (e) { /* device resets */ }
      }
    } catch (e) {
      // Device may reset here — that's expected
    }

    this.log(`Flash complete! ${bytesWritten} bytes written.`);
  }

  async close() {
    if (this.device) {
      try {
        await this.device.releaseInterface(this.interfaceNumber);
        await this.device.close();
      } catch (e) {
        // Device may have already disconnected
      }
      this.device = null;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Check WebUSB support
export function isWebUSBSupported() {
  return !!navigator.usb;
}

export function isChromeBrowser() {
  return /Chrome|Chromium|Edg/.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent);
}
