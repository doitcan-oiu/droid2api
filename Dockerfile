# 使用官方 Node.js 运行时作为基础镜像
FROM node:24-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装生产依赖
RUN npm ci --only=production

# 复制项目文件
COPY server.js ./
COPY src/ ./src/
COPY config/ ./config/

# data/ 目录由程序按需自动创建（存储 refresh token 运行时状态）

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production

# 启动应用
CMD ["node", "server.js"]
