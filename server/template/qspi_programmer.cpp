// Minimal QSPI Programmer for Daisy
// Runs from internal flash (0x08000000). Writes embedded firmware
// to QSPI flash at 0x90040000, then jumps to it.
//
// Skips System::Init() (PLL, MPU, cache, timer) to minimize code size.
// Runs at default HSI 64 MHz — enough for QSPI operations.

#include "per/qspi.h"
#include "daisy_core.h"
#include "stm32h7xx_hal.h"
#include "app_data.h"

using namespace daisy;

static QSPIHandle qspi;

static constexpr uint32_t QSPI_APP_OFFSET = 0x40000;
static constexpr uint32_t QSPI_APP_ADDR   = 0x90040000;

static void JumpToApplication()
{
    volatile uint32_t* v = (volatile uint32_t*)QSPI_APP_ADDR;
    __disable_irq();
    SysTick->CTRL = 0;
    for(uint32_t i = 0; i < 8; i++)
    {
        NVIC->ICER[i] = 0xFFFFFFFF;
        NVIC->ICPR[i] = 0xFFFFFFFF;
    }
    SCB->VTOR = QSPI_APP_ADDR;
    __set_MSP(v[0]);
    __enable_irq();
    ((void (*)(void))v[1])();
}

int main(void)
{
    HAL_Init();

    // Init QSPI in memory-mapped mode for fingerprint check
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

    // Fingerprint: compare first bytes to skip unnecessary re-flash
    volatile uint8_t* mapped = (volatile uint8_t*)QSPI_APP_ADDR;
    bool needs_update = false;
    uint32_t check_len = app_firmware_size < 256 ? app_firmware_size : 256;
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
        uint32_t erase_end = QSPI_APP_OFFSET + app_firmware_size;
        erase_end = (erase_end + 0xFFFF) & ~0xFFFF;
        qspi.Erase(QSPI_APP_OFFSET, erase_end);
        qspi.Write(QSPI_APP_OFFSET, app_firmware_size,
                    const_cast<uint8_t*>(app_firmware));

        // Reset so QSPI re-inits in memory-mapped mode
        HAL_Delay(50);
        NVIC_SystemReset();
        while(1) {}
    }

    JumpToApplication();
    while(1) {}
}
