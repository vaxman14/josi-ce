#!/bin/sh
cd /opt/heyjosi/src
docker build -f apps/hosted/Dockerfile -t heyjosi-hosted:9324835 -t heyjosi-hosted:latest . > /opt/heyjosi/build.log 2>&1
echo "exit $?" >> /opt/heyjosi/build.log
