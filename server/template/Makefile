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

# DaisySP library sources included via static lib
LIBS = -ldaisysp -ldaisy -lc -lm -lnosys

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

# Include paths
C_INCLUDES = \
  -I$(LIBDAISY_DIR)/src \
  -I$(LIBDAISY_DIR)/src/daisy_patch.h \
  -I$(LIBDAISY_DIR)/Drivers/CMSIS/Include \
  -I$(LIBDAISY_DIR)/Drivers/CMSIS/Device/ST/STM32H7xx/Include \
  -I$(LIBDAISY_DIR)/Drivers/STM32H7xx_HAL_Driver/Inc \
  -I$(LIBDAISY_DIR)/Middlewares/ST/STM32_USB_Device_Library/Core/Inc \
  -I$(LIBDAISY_DIR)/core \
  -I$(DAISYSP_DIR)/Source

# Library paths
LIBDIR = \
  -L$(LIBDAISY_DIR)/build \
  -L$(DAISYSP_DIR)/build

# Compile flags
CXXFLAGS = $(MCU) $(OPT) -Wall -fdata-sections -ffunction-sections -fno-exceptions -fno-rtti
CXXFLAGS += $(C_INCLUDES)
CXXFLAGS += -DSTM32H750xx -DUSE_HAL_DRIVER

# Linker flags
LDFLAGS = $(MCU) -specs=nano.specs -specs=nosys.specs
LDFLAGS += -T$(LDSCRIPT)
LDFLAGS += $(LIBDIR) $(LIBS)
LDFLAGS += -Wl,--gc-sections
LDFLAGS += -Wl,-Map=build/$(TARGET).map,--cref

# Build directory
BUILD_DIR = build

# Object files
OBJECTS = $(addprefix $(BUILD_DIR)/,$(notdir $(CPP_SOURCES:.cpp=.o)))

# Startup file from libDaisy
OBJECTS += $(LIBDAISY_DIR)/core/startup_stm32h750xx.o

all: $(BUILD_DIR)/$(TARGET).bin

$(BUILD_DIR)/%.o: %.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

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
