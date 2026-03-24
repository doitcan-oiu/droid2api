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

# 声明持久化卷（存储刷新后的令牌状态）
# Zeabur/Docker 等平台会自动识别并提供持久化存储
VOLUME /app/data

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production

# 启动应用
CMD ["node", "server.js"]
