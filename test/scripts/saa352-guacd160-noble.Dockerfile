# guacd 1.6.0 from source on Ubuntu 24.04 FreeRDP 3.
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl build-essential \
    libcairo2-dev libjpeg-turbo8-dev libpng-dev libtool-bin uuid-dev libavcodec-dev libavformat-dev libavutil-dev libswscale-dev \
    freerdp3-dev libvncserver-dev libssl-dev libwebp-dev libpulse-dev libpango1.0-dev
RUN curl -fsSL https://archive.apache.org/dist/guacamole/1.6.0/source/guacamole-server-1.6.0.tar.gz | tar -xz -C /tmp && cd /tmp/guacamole-server-1.6.0 && \
    CFLAGS="-O2 -Wno-error=deprecated-declarations" ./configure --prefix=/opt/guacd --with-freerdp-plugin-dir=/opt/guacd/lib/freerdp3 --disable-guacenc --disable-guaclog --without-ssh --without-telnet --without-kubernetes && make -j8 && make install
ENV LD_LIBRARY_PATH=/opt/guacd/lib
CMD ["/opt/guacd/sbin/guacd","-f","-b","0.0.0.0","-l","4822","-L","debug"]
