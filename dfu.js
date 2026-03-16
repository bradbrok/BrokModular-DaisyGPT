// WebUSB DfuSe (DFU with ST Extensions) for Daisy
// Based on electro-smith/Programmer (MIT License)
// Reference: USB DFU 1.1 + ST DfuSe protocol

const DFU_DNLOAD    = 0x01;
const DFU_GETSTATUS = 0x03;
const DFU_CLRSTATUS = 0x04;
const DFU_ABORT     = 0x06;

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

// DfuSe commands (sent via DNLOAD at block 0)
const DFUSE_SET_ADDRESS  = 0x21;
const DFUSE_ERASE_SECTOR = 0x41;

const FLASH_BASE = 0x08000000;

export class DaisyDFU {
  constructor() {
    this.device = null;
    this.interfaceNumber = 0;
    this.transferSize = 1024; // STM32 DfuSe uses 1024
    this.onProgress = null;
    this.onLog = null;
  }

  log(msg) {
    if (this.onLog) this.onLog(msg);
  }

  async requestDevice() {
    const filters = [
      { vendorId: 0x0483, productId: 0xDF11 },
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

    if (!this.device.configuration) {
      await this.device.selectConfiguration(1);
    }

    // Find the DFU interface and collect alternates
    this.alternates = [];
    for (const iface of this.device.configuration.interfaces) {
      for (const alt of iface.alternates) {
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

    // Select the alternate for internal flash (name contains 0x08000000)
    let selected = false;
    for (const alt of this.alternates) {
      if (alt.name.includes('0x08000000') || alt.name.toLowerCase().includes('internal')) {
        await this.device.selectAlternateInterface(this.interfaceNumber, alt.alternateSetting);
        this.log(`Claimed interface ${this.interfaceNumber}, alternate ${alt.alternateSetting}: ${alt.name}`);
        selected = true;
        break;
      }
    }
    if (!selected && this.alternates.length > 0) {
      await this.device.selectAlternateInterface(this.interfaceNumber, this.alternates[0].alternateSetting);
      this.log(`Claimed interface ${this.interfaceNumber}, alternate ${this.alternates[0].alternateSetting}`);
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
      throw new Error(`GET_STATUS transfer: ${result.status}`);
    }

    const d = result.data;
    return {
      status: d.getUint8(0),
      pollTimeout: d.getUint32(1, true) & 0xFFFFFF,  // 24-bit LE, mask off byte 4
      state: d.getUint8(4),
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

  async abort() {
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: DFU_ABORT,
      value: 0,
      index: this.interfaceNumber,
    });
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

  /** Poll getStatus until state leaves dfuDNBUSY */
  async pollUntilIdle() {
    let status = await this.getStatus();
    while (status.state !== DFU_STATE.dfuDNLOAD_IDLE &&
           status.state !== DFU_STATE.dfuERROR &&
           status.state !== DFU_STATE.dfuIDLE) {
      await this._sleep(status.pollTimeout || 100);
      status = await this.getStatus();
    }
    if (status.state === DFU_STATE.dfuERROR) {
      throw new Error(`DFU error (status ${status.status})`);
    }
    return status;
  }

  /** Send DfuSe special command (block 0) and poll until done */
  async dfuseCommand(command, address) {
    const payload = new ArrayBuffer(5);
    const view = new DataView(payload);
    view.setUint8(0, command);
    view.setUint32(1, address, true);
    await this.download(0, payload);
    await this.pollUntilIdle();
  }

  async abortToIdle() {
    await this.abort();
    let status = await this.getStatus();
    if (status.state === DFU_STATE.dfuERROR) {
      await this.clearStatus();
      status = await this.getStatus();
    }
    return status;
  }

  async flash(firmware, baseAddress = FLASH_BASE) {
    if (!this.device) throw new Error('No device connected');

    const totalBytes = firmware.byteLength;
    let bytesWritten = 0;
    const xferSize = this.transferSize;

    this.log(`Flashing ${totalBytes} bytes to 0x${baseAddress.toString(16)}...`);

    // Get to dfuIDLE
    let status = await this.abortToIdle();
    this.log(`DFU state: ${status.state}`);
    if (status.state !== DFU_STATE.dfuIDLE) {
      throw new Error(`Cannot reach dfuIDLE (state ${status.state})`);
    }

    // Erase sectors covering the firmware (128KB sectors for STM32H750)
    const sectorSize = 0x20000;
    for (let addr = baseAddress; addr < baseAddress + totalBytes; addr += sectorSize) {
      this.log(`Erasing sector at 0x${addr.toString(16)}...`);
      await this.dfuseCommand(DFUSE_ERASE_SECTOR, addr);
    }
    this.log('Erase complete, writing...');

    // Write data: DfuSe requires SET_ADDRESS before each chunk, data at block 2
    let address = baseAddress;
    for (let offset = 0; offset < totalBytes; offset += xferSize) {
      const end = Math.min(offset + xferSize, totalBytes);
      const chunk = firmware.slice(offset, end);

      // Set address pointer for this chunk
      await this.dfuseCommand(DFUSE_SET_ADDRESS, address);

      // Send data at block 2
      await this.download(2, chunk);
      await this.pollUntilIdle();

      address += chunk.byteLength;
      bytesWritten += chunk.byteLength;

      if (this.onProgress) {
        this.onProgress({
          phase: 'write',
          current: bytesWritten,
          total: totalBytes,
          percent: Math.round((bytesWritten / totalBytes) * 100),
        });
      }
    }

    this.log('Write complete, manifesting...');

    // Manifestation: set address to start, then zero-length DNLOAD at block 0
    await this.dfuseCommand(DFUSE_SET_ADDRESS, baseAddress);
    await this.download(0, new ArrayBuffer(0));
    try {
      status = await this.getStatus();
      // Poll until manifest
      while (status.state !== DFU_STATE.dfuMANIFEST &&
             status.state !== DFU_STATE.dfuMANIFEST_WAIT_RESET &&
             status.state !== DFU_STATE.dfuIDLE) {
        await this._sleep(status.pollTimeout || 100);
        status = await this.getStatus();
      }
    } catch (e) {
      // Device resets during manifestation — expected
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

export function isWebUSBSupported() {
  return !!navigator.usb;
}

export function isChromeBrowser() {
  return /Chrome|Chromium|Edg/.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent);
}
