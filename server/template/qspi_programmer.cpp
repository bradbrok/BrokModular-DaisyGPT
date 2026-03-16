// Minimal QSPI Programmer for Daisy
// Runs from internal flash (0x08000000). On boot, writes the embedded
// firmware to QSPI flash, then jumps to the QSPI application.
//
// Uses System + QSPIHandle directly (not DaisySeed) to minimize code size.

#include "sys/system.h"
#include "per/qspi.h"
#include "daisy_core.h"
#include "stm32h7xx_hal.h"
#include "app_data.h"

using namespace daisy;

static System sys;
static QSPIHandle qspi;

static constexpr uint32_t QSPI_APP_OFFSET = 0x40000;
static constexpr uint32_t QSPI_APP_ADDR   = 0x90040000;

static void JumpToApplication()
{
    volatile uint32_t* vectors = (volatile uint32_t*)QSPI_APP_ADDR;

    __disable_irq();

    SysTick->CTRL = 0;
    SysTick->LOAD = 0;
    SysTick->VAL  = 0;

    for(uint32_t i = 0; i < 8; i++)
    {
        NVIC->ICER[i] = 0xFFFFFFFF;
        NVIC->ICPR[i] = 0xFFFFFFFF;
    }

    SCB->VTOR = QSPI_APP_ADDR;
    __set_MSP(vectors[0]);
    __enable_irq();

    void (*entry)(void) = (void (*)(void))vectors[1];
    entry();
}

int main(void)
{
    // Minimal init: clocks, MPU, caches — no USB/ADC/DAC/audio
    sys.Init();

    // Configure QSPI for IS25LP064A on Daisy hardware pins
    QSPIHandle::Config qcfg;
    qcfg.device = QSPIHandle::Config::IS25LP064A;
    qcfg.mode   = QSPIHandle::Config::MEMORY_MAPPED;
    qcfg.pin_config.io0 = dsy_pin(DSY_GPIOF, 8);
    qcfg.pin_config.io1 = dsy_pin(DSY_GPIOF, 9);
    qcfg.pin_config.io2 = dsy_pin(DSY_GPIOF, 7);
    qcfg.pin_config.io3 = dsy_pin(DSY_GPIOF, 6);
    qcfg.pin_config.clk = dsy_pin(DSY_GPIOF, 10);
    qcfg.pin_config.ncs = dsy_pin(DSY_GPIOG, 6);
    qspi.Init(qcfg);

    // Fingerprint check: compare first bytes to avoid unnecessary re-flash
    volatile uint8_t* mapped = (volatile uint8_t*)QSPI_APP_ADDR;
    bool needs_update = false;
    uint32_t check_len = app_firmware_size < 512 ? app_firmware_size : 512;

    for(uint32_t i = 0; i < check_len; i++)
    {
        if(mapped[i] != app_firmware[i])
        {
            needs_update = true;
            break;
        }
    }

    if(needs_update)
    {
        // Erase QSPI sectors covering the firmware
        uint32_t erase_end = QSPI_APP_OFFSET + app_firmware_size;
        erase_end = (erase_end + 0xFFFF) & ~0xFFFF;
        qspi.Erase(QSPI_APP_OFFSET, erase_end);

        // Write firmware to QSPI
        qspi.Write(QSPI_APP_OFFSET, app_firmware_size,
                    const_cast<uint8_t*>(app_firmware));

        // System reset so QSPI re-inits in memory-mapped mode cleanly
        System::Delay(50);
        NVIC_SystemReset();
        while(1) {}
    }

    // QSPI has correct firmware and is memory-mapped — jump
    JumpToApplication();
    while(1) {}
}
