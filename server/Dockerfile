# Stage 1: Build libDaisy and DaisySP
FROM ubuntu:22.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc-arm-none-eabi \
    libnewlib-arm-none-eabi \
    libstdc++-arm-none-eabi-newlib \
    build-essential \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Clone and build libDaisy at pinned tag (needs submodules for HAL drivers)
RUN git clone --recursive --depth 1 --branch v7.0.1 https://github.com/electro-smith/libDaisy.git \
    && cd libDaisy && make -j$(nproc)

# Clone and build DaisySP (pinned to master HEAD — no recent release tags)
RUN git clone --recursive --depth 1 https://github.com/electro-smith/DaisySP.git \
    && cd DaisySP && make -j$(nproc)

# Stage 2: Runtime
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc-arm-none-eabi \
    libnewlib-arm-none-eabi \
    libstdc++-arm-none-eabi-newlib \
    build-essential \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Copy built libraries, headers, and linker scripts
COPY --from=builder /build/libDaisy /opt/daisy/libDaisy
COPY --from=builder /build/DaisySP /opt/daisy/DaisySP

# Create non-root user
RUN useradd -m -s /bin/bash daisy

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy server code
COPY . .

RUN chown -R daisy:daisy /app

USER daisy

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "4", "--timeout", "120", "app:app"]
