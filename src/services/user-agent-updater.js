/**
 * @file User-Agent 版本更新服务
 * @description 定时从 Factory 官方获取最新 CLI 版本号，保持 User-Agent 与官方一致
 *              启动时立即获取，之后每小时检查一次
 */

import https from 'https';
import { logInfo, logError } from '../utils/logger.js';
import { getConfig } from '../config/index.js';

/** 版本检查地址 */
const VERSION_URL = 'https://downloads.factory.ai/factory-cli/LATEST';
/** User-Agent 前缀 */
const USER_AGENT_PREFIX = 'factory-cli';
/** 定时检查间隔（1 小时） */
const CHECK_INTERVAL = 60 * 60 * 1000;
/** 失败重试间隔（1 分钟） */
const RETRY_INTERVAL = 60 * 1000;
/** 最大重试次数 */
const MAX_RETRIES = 3;

/** 当前版本号 */
let currentVersion = null;
/** 是否正在更新中（防止并发） */
let isUpdating = false;

/**
 * 从配置文件获取默认版本号
 * @returns {string}
 */
function getDefaultVersion() {
  const cfg = getConfig();
  const userAgent = cfg.user_agent || 'factory-cli/0.19.3';
  const match = userAgent.match(/\/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '0.19.3';
}

/**
 * 初始化版本号（首次加载时使用配置文件中的默认值）
 */
function initializeVersion() {
  if (currentVersion === null) {
    currentVersion = getDefaultVersion();
  }
}

/**
 * 获取当前 User-Agent 字符串
 * @returns {string} 格式: factory-cli/x.y.z
 */
export function getCurrentUserAgent() {
  initializeVersion();
  return `${USER_AGENT_PREFIX}/${currentVersion}`;
}

/**
 * 从远程获取最新版本号
 * @returns {Promise<string>} 版本号
 */
function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const request = https.get(VERSION_URL, (res) => {
      let data = '';

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        const version = data.trim();
        if (version && /^\d+\.\d+\.\d+/.test(version)) {
          resolve(version);
        } else {
          reject(new Error(`无效的版本号格式: ${version}`));
        }
      });
    });

    request.on('error', (err) => {
      reject(err);
    });

    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('请求超时'));
    });
  });
}

/**
 * 带重试的版本更新
 * @param {number} retryCount - 当前重试次数
 */
async function updateVersionWithRetry(retryCount = 0) {
  if (isUpdating) return;

  isUpdating = true;

  try {
    const version = await fetchLatestVersion();
    if (version !== currentVersion) {
      const oldVersion = currentVersion;
      currentVersion = version;
      logInfo(`User-Agent 版本已更新: ${oldVersion} -> ${currentVersion}`);
    } else {
      logInfo(`User-Agent 版本已是最新: ${currentVersion}`);
    }
    isUpdating = false;
  } catch (error) {
    logError(`获取最新版本失败 (第 ${retryCount + 1}/${MAX_RETRIES} 次)`, error);

    if (retryCount < MAX_RETRIES - 1) {
      logInfo('将在 1 分钟后重试...');
      setTimeout(() => {
        updateVersionWithRetry(retryCount + 1);
      }, RETRY_INTERVAL);
    } else {
      logError('已达最大重试次数，将在下一次定时检查时重试');
      isUpdating = false;
    }
  }
}

/**
 * 初始化 User-Agent 版本定时更新器
 * 启动时立即获取一次，之后每小时检查
 */
export function initializeUserAgentUpdater() {
  initializeVersion();
  logInfo('初始化 User-Agent 版本更新器...');
  logInfo(`默认 User-Agent: ${USER_AGENT_PREFIX}/${currentVersion}`);

  // 启动时立即获取
  updateVersionWithRetry();

  // 定时检查（每小时）
  setInterval(() => {
    logInfo('执行定时 User-Agent 版本检查...');
    updateVersionWithRetry();
  }, CHECK_INTERVAL);

  logInfo('User-Agent 更新器已初始化，每小时检查一次');
}
