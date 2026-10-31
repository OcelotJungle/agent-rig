FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash \
		ca-certificates \
		coreutils \
		curl \
		diffutils \
		findutils \
		git \
		grep \
		nodejs \
		procps \
		python3 \
		sed \
		tar \
		tmux \
		unzip \
		util-linux \
	&& rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash rig

COPY fakes/ /opt/rig-fakes/
RUN chmod 0755 /opt/rig-fakes/*

ENV HOME=/home/rig
ENV PATH=/opt/rig-fakes:/home/rig/.local/bin:/home/rig/.bun/bin:${PATH}

USER rig
WORKDIR /workspace

CMD ["bash"]
