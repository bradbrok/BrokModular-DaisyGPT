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

    for (const iface of this.device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        // DFU class = 0xFE, subclass = 0x01
        if (alt.interfaceClass === 0xFE && alt.interfaceSubclass === 0x01) {
          this.interfaceNumber = iface.interfaceNumber;
          break;
        }
      }
    }

    await this.device.claimInterface(this.interfaceNumber);
    this.log(`Claimed interface ${this.interfaceNumber}`);
  }

  async getStatus() {
    const result = await this.device.controlTransferIn({
      requestType: 'class',
      recipient: 'interface',
      request: DFU_GETSTATUS,
      value: 0,
      index: this.interfaceNumber,
    }, 6);

    const data = new DataView(result.data.buffer);
    return {
      status: data.getUint8(0),
      pollTimeout: data.getUint8(1) | (data.getUint8(2) << 8) | (data.getUint8(3) << 16),
      state: data.getUint8(4),
      string: data.getUint8(5),
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

  async eraseSector(address) {
    const data = new Uint8Array(5);
    data[0] = ERASE_PAGE;
    data[1] = address & 0xFF;
    data[2] = (address >> 8) & 0xFF;
    data[3] = (address >> 16) & 0xFF;
    data[4] = (address >> 24) & 0xFF;

    await this.download(0, data);

    // Erase can take a while
    let status;
    for (let i = 0; i < 100; i++) {
      status = await this.getStatus();
      if (status.state === DFU_STATE.dfuDNLOAD_IDLE) break;
      if (status.state === DFU_STATE.dfuERROR) {
        await this.clearStatus();
        throw new Error(`Erase error at 0x${address.toString(16)}`);
      }
      await this._sleep(Math.max(status.pollTimeout, 100));
    }
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

    // Ensure we're in dfuIDLE
    let status = await this.getStatus();
    if (status.state === DFU_STATE.dfuERROR) {
      await this.clearStatus();
    }
    if (status.state !== DFU_STATE.dfuIDLE) {
      // Try abort
      await this.device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: DFU_ABORT,
        value: 0,
        index: this.interfaceNumber,
      });
      await this.waitForState(DFU_STATE.dfuIDLE);
    }

    // Erase sectors that will be written
    const sectorSize = 0x20000; // 128KB sectors for STM32H750
    const startSector = baseAddress;
    const endSector = baseAddress + totalBytes;
    for (let addr = startSector; addr < endSector; addr += sectorSize) {
      this.log(`Erasing sector at 0x${addr.toString(16)}...`);
      await this.eraseSector(addr);
      if (this.onProgress) {
        this.onProgress({ phase: 'erase', current: addr - startSector, total: endSector - startSector });
      }
    }

    // Set start address
    await this.setAddress(baseAddress);

    // Write data in blocks
    let blockNum = 2; // block 0 and 1 are for DFU commands
    for (let offset = 0; offset < totalBytes; offset += blockSize) {
      const end = Math.min(offset + blockSize, totalBytes);
      const chunk = new Uint8Array(firmware.slice(offset, end));

      await this.download(blockNum, chunk);

      status = await this.getStatus();
      while (status.state === DFU_STATE.dfuDNBUSY) {
        await this._sleep(status.pollTimeout || 10);
        status = await this.getStatus();
      }

      if (status.state !== DFU_STATE.dfuDNLOAD_IDLE) {
        throw new Error(`Unexpected state ${status.state} during download`);
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

    // Send zero-length download to signal end
    await this.download(0, new ArrayBuffer(0));
    try {
      await this.getStatus();
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
