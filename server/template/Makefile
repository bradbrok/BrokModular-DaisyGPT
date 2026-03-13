# DaisyGPT ARM Compilation Makefile
TARGET = patch

# Directories — set via environment
LIBDAISY_DIR ?= /opt/daisy/libDaisy
DAISYSP_DIR ?= /opt/daisy/DaisySP

# Boot target: flash (0x08000000) or qspi (0x90040000)
BOOT_TARGET ?= flash

# Optimization
OPT = -O2

# Sources
CPP_SOURCES = patch.cpp

# Toolchain
PREFIX = arm-none-eabi-
CC = $(PREFIX)gcc
CXX = $(PREFIX)g++
AS = $(PREFIX)gcc -x assembler-with-cpp
CP = $(PREFIX)objcopy
SZ = $(PREFIX)size

# MCU flags for Cortex-M7 (STM32H750)
CPU = -mcpu=cortex-m7
FPU = -mfpu=fpv5-d16
FLOAT-ABI = -mfloat-abi=hard
MCU = $(CPU) -mthumb $(FPU) $(FLOAT-ABI)

# Linker script
ifeq ($(BOOT_TARGET),qspi)
  LDSCRIPT = $(LIBDAISY_DIR)/core/STM32H750IB_qspi.lds
  BOOT_ADDRESS = 0x90040000
else
  LDSCRIPT = $(LIBDAISY_DIR)/core/STM32H750IB_flash.lds
  BOOT_ADDRESS = 0x08000000
endif

# Include paths (matching libDaisy's own Makefile structure)
C_INCLUDES = \
  -I$(LIBDAISY_DIR)/src \
  -I$(LIBDAISY_DIR)/src/sys \
  -I$(LIBDAISY_DIR)/src/usbd \
  -I$(LIBDAISY_DIR)/src/usbh \
  -I$(LIBDAISY_DIR)/Drivers/CMSIS_5/CMSIS/Core/Include \
  -I$(LIBDAISY_DIR)/Drivers/CMSIS-Device/ST/STM32H7xx/Include \
  -I$(LIBDAISY_DIR)/Drivers/STM32H7xx_HAL_Driver/Inc \
  -I$(LIBDAISY_DIR)/Drivers/STM32H7xx_HAL_Driver/Inc/Legacy \
  -I$(LIBDAISY_DIR)/Middlewares/ST/STM32_USB_Device_Library/Core/Inc \
  -I$(LIBDAISY_DIR)/Middlewares/Patched/ST/STM32_USB_Device_Library/Class/CDC/Inc \
  -I$(LIBDAISY_DIR)/Middlewares/ST/STM32_USB_Host_Library/Core/Inc \
  -I$(LIBDAISY_DIR)/Middlewares/ST/STM32_USB_Host_Library/Class/MSC/Inc \
  -I$(LIBDAISY_DIR)/Middlewares/Third_Party/FatFs/src \
  -I$(LIBDAISY_DIR)/core \
  -I$(DAISYSP_DIR)/Source

# Library paths
LIBDIR = \
  -L$(LIBDAISY_DIR)/build \
  -L$(DAISYSP_DIR)/build

# Compile flags
CXXFLAGS = $(MCU) $(OPT) -Wall -fdata-sections -ffunction-sections -fno-exceptions -fno-rtti
CXXFLAGS += $(C_INCLUDES)
CXXFLAGS += -DCORE_CM7 -DSTM32H750xx -DSTM32H750IB -DARM_MATH_CM7 -DUSE_HAL_DRIVER -DUSE_FULL_LL_DRIVER
CXXFLAGS += -DHSE_VALUE=16000000 -DDATA_IN_D2_SRAM
CXXFLAGS += -std=gnu++14 -Wno-register

ASFLAGS = $(MCU) -Wall -fdata-sections -ffunction-sections

# Linker flags
LDFLAGS = $(MCU) -specs=nano.specs -specs=nosys.specs
LDFLAGS += -T$(LDSCRIPT)
LDFLAGS += $(LIBDIR)
LDFLAGS += -ldaisysp -ldaisy -lc -lm -lnosys
LDFLAGS += -Wl,--gc-sections
LDFLAGS += -Wl,-Map=build/$(TARGET).map,--cref

# Build directory
BUILD_DIR = build

# Object files
OBJECTS = $(addprefix $(BUILD_DIR)/,$(notdir $(CPP_SOURCES:.cpp=.o)))

# Assemble startup file locally (source is in /opt/daisy, build locally)
OBJECTS += $(BUILD_DIR)/startup_stm32h750xx.o

all: $(BUILD_DIR)/$(TARGET).bin

$(BUILD_DIR)/%.o: %.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD_DIR)/startup_stm32h750xx.o: $(LIBDAISY_DIR)/core/startup_stm32h750xx.s | $(BUILD_DIR)
	$(AS) $(ASFLAGS) -c $< -o $@

$(BUILD_DIR)/$(TARGET).elf: $(OBJECTS)
	$(CXX) $(OBJECTS) $(LDFLAGS) -o $@
	$(SZ) $@

$(BUILD_DIR)/$(TARGET).bin: $(BUILD_DIR)/$(TARGET).elf
	$(CP) -O binary -S $< $@

$(BUILD_DIR):
	mkdir -p $@

clean:
	rm -rf $(BUILD_DIR)

.PHONY: all clean
