// WebUSB DfuSe (DFU with ST Extensions) for Daisy
// Based on electro-smith/Programmer (MIT License)
// Reference: USB DFU 1.1 + ST DfuSe protocol
//
// Supports two-phase flashing for QSPI:
//   Phase 1: Flash Daisy bootloader to internal flash via ROM DfuSe
//   Phase 2: Flash user app to QSPI via Daisy bootloader DfuSe

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
const QSPI_BASE  = 0x90040000;

export class DaisyDFU {
  constructor() {
    this.device = null;
    this.interfaceNumber = 0;
    this.transferSize = 1024;
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

    // Select first alternate by default
    if (this.alternates.length > 0) {
      await this.device.selectAlternateInterface(this.interfaceNumber, this.alternates[0].alternateSetting);
    }

    const names = this.alternates.map(a => a.name).join(', ');
    this.log(`Claimed interface ${this.interfaceNumber} [${names || 'no name'}]`);
  }

  /** Detect whether we're connected to the ROM bootloader or Daisy bootloader.
   *  Primary: product name. Fallback: alternate interface names. */
  isRomBootloader() {
    const prod = (this.device.productName || '').toLowerCase();
    if (prod.includes('dfu in fs mode') || prod.includes('stm32')) return true;
    if (this.alternates.some(a => a.name.includes('0x08000000'))) return true;
    // If no Daisy signature found, assume ROM
    return !this.isDaisyBootloader();
  }

  isDaisyBootloader() {
    const prod = (this.device.productName || '').toLowerCase();
    if (prod.includes('daisy')) return true;
    return this.alternates.some(a => a.name.includes('0x90000000'));
  }

  /** Select the alternate interface whose name contains the given address prefix */
  async selectAlternateForAddress(address) {
    const addrStr = '0x' + (address & 0xF0000000).toString(16).padStart(8, '0');
    for (const alt of this.alternates) {
      if (alt.name.includes(addrStr) || alt.name.includes(address.toString(16))) {
        await this.device.selectAlternateInterface(this.interfaceNumber, alt.alternateSetting);
        this.log(`Selected alternate ${alt.alternateSetting}: ${alt.name}`);
        return;
      }
    }
    // Fallback: first alternate
    if (this.alternates.length > 0) {
      await this.device.selectAlternateInterface(this.interfaceNumber, this.alternates[0].alternateSetting);
    }
  }

  // ─── Low-level DFU protocol ────────────────────────────────────

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
      pollTimeout: d.getUint32(1, true) & 0xFFFFFF,
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

  // ─── Flash operations ──────────────────────────────────────────

  /** Erase sectors covering a memory range, using appropriate sector size */
  async eraseSectors(baseAddress, totalBytes) {
    // QSPI: 64KB sectors. Internal flash: 128KB sectors.
    const sectorSize = baseAddress >= 0x90000000 ? 0x10000 : 0x20000;
    for (let addr = baseAddress; addr < baseAddress + totalBytes; addr += sectorSize) {
      this.log(`Erasing sector at 0x${addr.toString(16)}...`);
      await this.dfuseCommand(DFUSE_ERASE_SECTOR, addr);
    }
  }

  /** Write firmware to the device at the given address */
  async flash(firmware, baseAddress = FLASH_BASE) {
    if (!this.device) throw new Error('No device connected');

    const totalBytes = firmware.byteLength;
    let bytesWritten = 0;
    const xferSize = this.transferSize;

    this.log(`Flashing ${totalBytes} bytes to 0x${baseAddress.toString(16)}...`);

    // Select correct alternate for target address
    await this.selectAlternateForAddress(baseAddress);

    // Get to dfuIDLE
    let status = await this.abortToIdle();
    if (status.state !== DFU_STATE.dfuIDLE) {
      throw new Error(`Cannot reach dfuIDLE (state ${status.state})`);
    }

    // Erase
    await this.eraseSectors(baseAddress, totalBytes);
    this.log('Erase complete, writing...');

    // Write: DfuSe requires SET_ADDRESS before each chunk, data at block 2
    let address = baseAddress;
    for (let offset = 0; offset < totalBytes; offset += xferSize) {
      const end = Math.min(offset + xferSize, totalBytes);
      const chunk = firmware.slice(offset, end);

      await this.dfuseCommand(DFUSE_SET_ADDRESS, address);
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

    // Manifestation: set address to start, zero-length DNLOAD at block 0
    await this.dfuseCommand(DFUSE_SET_ADDRESS, baseAddress);
    await this.download(0, new ArrayBuffer(0));
    try {
      status = await this.getStatus();
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

  /** Wait for device to disconnect (user taps RESET) then reconnect (bootloader starts) */
  async waitForReconnect(timeoutMs = 30000) {
    const isDfuDevice = d => d.vendorId === 0x0483 && d.productId === 0xDF11;
    const start = Date.now();

    // Wait for device to disappear (user taps RESET)
    this.log('Waiting for device to disconnect...');
    while (Date.now() - start < timeoutMs) {
      await this._sleep(500);
      const devices = await navigator.usb.getDevices();
      if (!devices.some(isDfuDevice)) break;
    }

    // Wait for device to reappear (Daisy bootloader starts)
    this.log('Waiting for Daisy bootloader...');
    while (Date.now() - start < timeoutMs) {
      await this._sleep(500);
      const devices = await navigator.usb.getDevices();
      const dev = devices.find(isDfuDevice);
      if (dev) {
        await this._sleep(1500); // Let USB fully enumerate
        this.device = dev;
        return;
      }
    }

    throw new Error('Timed out. Tap RESET on Daisy (without holding BOOT) and try again.');
  }

  /**
   * Two-phase QSPI flash:
   *   Phase 1: Flash bootloader to internal flash (if needed), then reconnect
   *   Phase 2: Flash app to QSPI via Daisy bootloader
   */
  async flashQSPI(appFirmware, bootloaderFirmware, appAddress = QSPI_BASE) {
    if (!this.device) throw new Error('No device connected');

    // Phase 1: If connected to ROM bootloader, flash the Daisy bootloader first
    if (this.isRomBootloader()) {
      this.log('ROM bootloader detected — flashing Daisy bootloader...');
      await this.flash(bootloaderFirmware, FLASH_BASE);

      // ROM bootloader is manifestation-tolerant — device won't auto-reset.
      // Close and wait for reconnect (user taps RESET, or we get auto-reconnect).
      this.log('Bootloader flashed! Tap RESET on your Daisy...');
      await this.close();

      // Wait for device to reconnect (user resets the board)
      await this.waitForReconnect(30000);
      await this.open();

      if (!this.isDaisyBootloader()) {
        // Might still be ROM bootloader if user held BOOT during reset.
        // Ask them to just tap RESET without holding BOOT.
        throw new Error('Daisy bootloader not detected. Tap RESET (without holding BOOT) and try again.');
      }
      this.log('Daisy bootloader connected!');

    } else if (this.isDaisyBootloader()) {
      this.log('Daisy bootloader already running');
    } else {
      throw new Error('Cannot determine bootloader type from device');
    }

    // Phase 2: Flash app to QSPI
    this.log('Flashing app to QSPI...');
    await this.flash(appFirmware, appAddress);
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
