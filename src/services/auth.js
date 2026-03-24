/**
 * @file 认证服务模块
 * @description 管理 API 密钥的获取与刷新，支持多账户轮询
 *
 *  设计理念：
 *    config/app.yaml    → 仅管理 factory_api_keys（静态密钥）
 *    data/auth.json     → 刷新令牌账户的唯一数据源（持久化存储）
 *    环境变量            → DROID_REFRESH_KEY 仅作为首次初始化种子
 *    API 接口            → 运行时动态添加/查看/删除令牌
 *
 *  认证优先级：factory_api_keys > data/auth.json 账户 > 客户端 Authorization
 *  多账户时采用轮询（round-robin）策略
 */

import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { logDebug, logError, logInfo } from '../utils/logger.js';
import { getNextProxyAgent } from './proxy-manager.js';
import { getAuthConfig, ROOT_DIR } from '../config/index.js';

// ======================== 常量 ========================

/** WorkOS 令牌刷新地址 */
const REFRESH_URL = 'https://api.workos.com/user_management/authenticate';
/** WorkOS 客户端 ID */
const CLIENT_ID = 'client_01HNM792M5G5G1A2THWPXKFMXB';
/** 刷新间隔（小时） */
const REFRESH_INTERVAL_HOURS = 6;
/** 运行时令牌存储路径 */
const STATE_FILE = path.join(ROOT_DIR, 'data', 'auth.json');

// ======================== 状态管理 ========================

/** 认证模式: 'factory_key' | 'refresh' | 'client' */
let authMode = 'client';

/** 固定 API Key 列表 */
let factoryKeys = [];
/** 固定 Key 轮询索引 */
let factoryKeyIndex = 0;

/**
 * 刷新账户列表
 * 每个账户: { refreshToken, accessToken, lastRefreshTime, label }
 */
let accounts = [];
/** 刷新账户轮询索引 */
let accountIndex = 0;

// ======================== data/auth.json 读写 ========================

/**
 * 从 data/auth.json 加载账户列表
 * @returns {Array} 账户数组
 */
function loadAccounts() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      // 兼容旧格式（对象）和新格式（数组）
      if (Array.isArray(raw)) {
        return raw;
      }
      // 旧格式: { seed: { access_token, refresh_token, ... } } → 转为数组
      return Object.values(raw).filter((v) => v && v.refresh_token);
    }
  } catch (error) {
    logDebug('读取 data/auth.json 失败', error);
  }
  return [];
}

/**
 * 将当前账户列表保存到 data/auth.json
 */
function saveAccounts() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = accounts.map((a) => ({
      refresh_token: a.refreshToken,
      access_token: a.accessToken,
      last_updated: a.lastRefreshTime ? new Date(a.lastRefreshTime).toISOString() : null,
      label: a.label || '',
    }));
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    logError('保存 data/auth.json 失败', error);
  }
}

// ======================== 令牌刷新 ========================

/**
 * 刷新指定账户的 API Key
 * @param {object} account - 账户对象
 */
async function refreshAccount(account) {
  logInfo(`正在刷新账户 [${account.label}] 的 API Key...`);

  const formData = new URLSearchParams();
  formData.append('grant_type', 'refresh_token');
  formData.append('refresh_token', account.refreshToken);
  formData.append('client_id', CLIENT_ID);

  const proxyAgentInfo = getNextProxyAgent(REFRESH_URL);
  const fetchOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
  };

  if (proxyAgentInfo?.agent) {
    fetchOptions.agent = proxyAgentInfo.agent;
  }

  const response = await fetch(REFRESH_URL, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`刷新令牌失败: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  // 更新账户状态
  account.accessToken = data.access_token;
  account.refreshToken = data.refresh_token;
  account.lastRefreshTime = Date.now();

  if (data.user?.email) {
    account.label = data.user.email;
  }

  if (data.user) {
    logInfo(`  用户: ${data.user.email} (${data.user.first_name} ${data.user.last_name})`);
  }

  // 持久化
  saveAccounts();

  logInfo(`  账户 [${account.label}] 刷新成功`);
}

/**
 * 判断账户是否需要刷新
 * @param {object} account
 * @returns {boolean}
 */
function shouldRefresh(account) {
  if (!account.lastRefreshTime) return true;
  const hours = (Date.now() - account.lastRefreshTime) / (1000 * 60 * 60);
  return hours >= REFRESH_INTERVAL_HOURS;
}

// ======================== 公共接口 ========================

/**
 * 初始化认证系统
 * @param {boolean} [isReload=false] - 是否为热加载触发
 */
export async function initializeAuth(isReload = false) {
  if (isReload) {
    logInfo('认证系统正在重新初始化（配置已变更）...');
  }

  // 重置状态
  authMode = 'client';
  factoryKeys = [];
  factoryKeyIndex = 0;
  accounts = [];
  accountIndex = 0;

  const authCfg = getAuthConfig();

  // ---- 优先级 1: 固定 API 密钥 ----
  if (authCfg.factory_api_keys.length > 0) {
    authMode = 'factory_key';
    factoryKeys = authCfg.factory_api_keys;
    logInfo(`认证系统已初始化：固定 API 密钥模式（${factoryKeys.length} 个密钥轮询）`);
    return;
  }

  // ---- 优先级 2: 从 data/auth.json 加载刷新令牌账户 ----
  const savedAccounts = loadAccounts();

  if (savedAccounts.length > 0) {
    // data/auth.json 有已保存的账户
    for (let i = 0; i < savedAccounts.length; i++) {
      const saved = savedAccounts[i];
      accounts.push({
        refreshToken: saved.refresh_token,
        accessToken: saved.access_token || null,
        lastRefreshTime: saved.last_updated ? new Date(saved.last_updated).getTime() : null,
        label: saved.label || `账户${i + 1}`,
      });
    }
  }

  // ---- 优先级 3: 环境变量 DROID_REFRESH_KEY 作为初始种子 ----
  // 仅当 data/auth.json 没有账户时使用（首次部署）
  if (accounts.length === 0) {
    const envKeys = (process.env.DROID_REFRESH_KEY || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (envKeys.length > 0) {
      logInfo(`从环境变量 DROID_REFRESH_KEY 导入 ${envKeys.length} 个初始令牌`);
      for (let i = 0; i < envKeys.length; i++) {
        accounts.push({
          refreshToken: envKeys[i],
          accessToken: null,
          lastRefreshTime: null,
          label: `账户${i + 1}`,
        });
      }
    }
  }

  // ---- 激活刷新令牌模式 ----
  if (accounts.length > 0) {
    authMode = 'refresh';
    logInfo(`认证系统：刷新令牌模式（${accounts.length} 个账户）`);

    // 逐个刷新需要更新的账户
    for (const account of accounts) {
      try {
        if (account.accessToken && !shouldRefresh(account)) {
          logInfo(`  [${account.label}] access_token 仍在有效期内，跳过刷新`);
        } else {
          await refreshAccount(account);
        }
      } catch (error) {
        logError(`  [${account.label}] 初始化失败: ${error.message}`);
      }
    }

    // 检查是否有可用账户
    const available = accounts.filter((a) => a.accessToken);
    if (available.length > 0) {
      logInfo(`认证系统初始化完成（${available.length}/${accounts.length} 个账户可用）`);
    } else {
      logInfo('所有账户均不可用，降级为客户端授权模式');
      logInfo('提示: 通过 POST /api/auth/keys 添加有效的刷新令牌');
      authMode = 'client';
    }
    return;
  }

  // ---- 无任何配置 ----
  logInfo('认证系统已初始化：客户端授权模式（无密钥配置）');
  logInfo('提示: 通过 POST /api/auth/keys 添加刷新令牌，或在请求中携带 Authorization 头');
}

/**
 * 获取 API Key（支持多账户轮询）
 * @param {string|null} clientAuthorization - 客户端请求头中的 Authorization 值
 * @returns {Promise<string>} "Bearer xxx" 格式的认证字符串
 */
export async function getApiKey(clientAuthorization = null) {
  // ---- 固定 API 密钥轮询 ----
  if (authMode === 'factory_key' && factoryKeys.length > 0) {
    const key = factoryKeys[factoryKeyIndex % factoryKeys.length];
    factoryKeyIndex++;
    return `Bearer ${key}`;
  }

  // ---- 刷新令牌账户轮询 ----
  if (authMode === 'refresh' && accounts.length > 0) {
    for (let attempt = 0; attempt < accounts.length; attempt++) {
      const idx = (accountIndex + attempt) % accounts.length;
      const account = accounts[idx];

      try {
        if (shouldRefresh(account)) {
          logInfo(`账户 [${account.label}] 的 access_token 已过期，正在刷新...`);
          await refreshAccount(account);
        }

        if (account.accessToken) {
          accountIndex = (idx + 1) % accounts.length;
          logDebug(`使用账户 [${account.label}] 的 API Key`);
          return `Bearer ${account.accessToken}`;
        }
      } catch (error) {
        logError(`账户 [${account.label}] 获取 API Key 失败`, error);
      }
    }

    throw new Error('所有刷新令牌账户均不可用');
  }

  // ---- 客户端授权头 ----
  if (clientAuthorization) {
    logDebug('使用客户端提供的 Authorization 头');
    return clientAuthorization;
  }

  throw new Error(
    '无可用认证。请通过 POST /api/auth/keys 添加刷新令牌，或在请求中提供 Authorization 头。'
  );
}

// ======================== API 管理接口 ========================

/**
 * 添加刷新令牌并立即刷新
 * @param {string} refreshKey - 刷新令牌
 * @returns {Promise<object>} { success, label, message }
 */
export async function addRefreshKey(refreshKey) {
  const account = {
    refreshToken: refreshKey.trim(),
    accessToken: null,
    lastRefreshTime: null,
    label: `账户${accounts.length + 1}`,
  };

  // 立即刷新，验证令牌有效性
  await refreshAccount(account);

  // 添加到账户列表
  accounts.push(account);

  // 如果当前是客户端模式，切换为刷新模式
  if (authMode === 'client') {
    authMode = 'refresh';
    logInfo('认证模式已切换为：刷新令牌模式');
  }

  logInfo(`新账户 [${account.label}] 已添加（共 ${accounts.length} 个账户）`);
  return { success: true, label: account.label, message: '令牌添加成功并已验证' };
}

/**
 * 删除指定索引的账户
 * @param {number} index - 账户索引（从 0 开始）
 * @returns {object} { success, message }
 */
export function removeRefreshKey(index) {
  if (index < 0 || index >= accounts.length) {
    return { success: false, message: `无效的索引: ${index}，当前共 ${accounts.length} 个账户` };
  }

  const removed = accounts.splice(index, 1)[0];
  saveAccounts();

  // 修正轮询索引
  if (accountIndex >= accounts.length) {
    accountIndex = 0;
  }

  // 如果没有账户了，降级为客户端模式
  if (accounts.length === 0 && authMode === 'refresh') {
    authMode = 'client';
    logInfo('所有账户已移除，降级为客户端授权模式');
  }

  logInfo(`账户 [${removed.label}] 已删除（剩余 ${accounts.length} 个账户）`);
  return { success: true, message: `账户 [${removed.label}] 已删除` };
}

/**
 * 获取认证状态信息
 * @returns {object} 状态概览
 */
export function getAuthStatus() {
  return {
    mode: authMode,
    factory_keys_count: factoryKeys.length,
    accounts: accounts.map((a, i) => ({
      index: i,
      label: a.label,
      has_access_token: !!a.accessToken,
      last_refresh: a.lastRefreshTime ? new Date(a.lastRefreshTime).toISOString() : null,
      needs_refresh: shouldRefresh(a),
    })),
  };
}
