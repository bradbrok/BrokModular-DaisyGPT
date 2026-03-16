// QSPI Programmer for Daisy
// Runs from internal flash (0x08000000). On boot, writes the embedded
// firmware to QSPI flash, then jumps to the QSPI application.
//
// Flow:
//   1. Init hardware (including QSPI in memory-mapped mode)
//   2. Compare QSPI contents to embedded firmware
//   3. If different: erase, write, then system-reset (ensures clean QSPI mapping)
//   4. If same: jump directly to QSPI application

#include "daisy_seed.h"
#include "stm32h7xx_hal.h"
#include "app_data.h"

using namespace daisy;

static DaisySeed hw;

static constexpr uint32_t QSPI_APP_OFFSET = 0x40000;
static constexpr uint32_t QSPI_APP_ADDR   = 0x90040000;

static void JumpToApplication()
{
    volatile uint32_t* app_vectors = (volatile uint32_t*)QSPI_APP_ADDR;

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
    __set_MSP(app_vectors[0]);
    __enable_irq();

    void (*app_entry)(void) = (void (*)(void))app_vectors[1];
    app_entry();
}

int main(void)
{
    hw.Init(false);
    hw.SetLed(false);

    // Fingerprint check: compare first bytes of QSPI to embedded firmware
    volatile uint8_t* qspi_mapped = (volatile uint8_t*)QSPI_APP_ADDR;
    bool needs_update = false;
    uint32_t check_len = app_firmware_size < 512 ? app_firmware_size : 512;

    for(uint32_t i = 0; i < check_len; i++)
    {
        if(qspi_mapped[i] != app_firmware[i])
        {
            needs_update = true;
            break;
        }
    }

    if(needs_update)
    {
        hw.SetLed(true);

        // Erase QSPI sectors covering the firmware (64 KB sectors)
        uint32_t erase_end = QSPI_APP_OFFSET + app_firmware_size;
        erase_end = (erase_end + 0xFFFF) & ~0xFFFF;  // align up to sector
        hw.qspi.Erase(QSPI_APP_OFFSET, erase_end);

        // Write firmware to QSPI
        hw.qspi.Write(QSPI_APP_OFFSET, app_firmware_size,
                       const_cast<uint8_t*>(app_firmware));

        hw.SetLed(false);

        // System reset so QSPI re-inits in memory-mapped mode cleanly
        System::Delay(50);
        NVIC_SystemReset();
        while(1) {}
    }

    // QSPI has correct firmware and is memory-mapped — jump
    JumpToApplication();

    while(1) {}
}
