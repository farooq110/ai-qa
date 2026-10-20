# Demo target app — the app test executions run against inside the cluster
FROM node:22-alpine
WORKDIR /demo
COPY infrastructure/demo-app .
EXPOSE 4600
CMD ["node", "server.cjs"]
