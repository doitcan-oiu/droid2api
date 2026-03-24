/**
 * @file 认证服务模块
 * @description 管理 API 密钥的获取与刷新，支持多账户轮询、自动锁定、重试切换
 *
 *  数据源：
 *    config/app.yaml    → factory_api_keys（静态密钥）+ 重试/锁定配置
 *    data/auth.json     → 刷新令牌账户（唯一数据源，持久化存储）
 *    环境变量            → DROID_REFRESH_KEY 仅作首次初始化种子
 *    API / Web UI       → 运行时动态管理令牌
 */

import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { logDebug, logError, logInfo } from '../utils/logger.js';
import { getNextProxyAgent } from './proxy-manager.js';
import { getAuthConfig, ROOT_DIR } from '../config/index.js';

// ======================== 常量 ========================

const REFRESH_URL = 'https://api.workos.com/user_management/authenticate';
const CLIENT_ID = 'client_01HNM792M5G5G1A2THWPXKFMXB';
const REFRESH_INTERVAL_HOURS = 6;
const STATE_FILE = path.join(ROOT_DIR, 'data', 'auth.json');

// ======================== 状态管理 ========================

/** 认证模式: 'factory_key' | 'refresh' | 'client' */
let authMode = 'client';

let factoryKeys = [];
let factoryKeyIndex = 0;

/**
 * 账户结构:
 * { refreshToken, accessToken, lastRefreshTime, label, locked, lockReason, lockTime }
 */
let accounts = [];
let accountIndex = 0;

// ======================== data/auth.json 读写 ========================

function loadAccounts() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (Array.isArray(raw)) return raw;
      // 兼容旧格式（对象 → 数组）
      return Object.values(raw).filter((v) => v && v.refresh_token);
    }
  } catch (e) {
    logDebug('读取 data/auth.json 失败', e);
  }
  return [];
}

function saveAccounts() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = accounts.map((a) => ({
      refresh_token: a.refreshToken,
      access_token: a.accessToken,
      last_updated: a.lastRefreshTime ? new Date(a.lastRefreshTime).toISOString() : null,
      label: a.label || '',
      locked: a.locked || false,
      lock_reason: a.lockReason || null,
      lock_time: a.lockTime || null,
    }));
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    logError('保存 data/auth.json 失败', e);
  }
}

// ======================== 令牌刷新 ========================

async function refreshAccount(account) {
  logInfo(`正在刷新账户 [${account.label}] ...`);

  const formData = new URLSearchParams();
  formData.append('grant_type', 'refresh_token');
  formData.append('refresh_token', account.refreshToken);
  formData.append('client_id', CLIENT_ID);

  const proxyAgentInfo = getNextProxyAgent(REFRESH_URL);
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
  };
  if (proxyAgentInfo?.agent) opts.agent = proxyAgentInfo.agent;

  const response = await fetch(REFRESH_URL, opts);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`刷新失败: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  account.accessToken = data.access_token;
  account.refreshToken = data.refresh_token;
  account.lastRefreshTime = Date.now();
  if (data.user?.email) account.label = data.user.email;

  if (data.user) {
    logInfo(`  用户: ${data.user.email} (${data.user.first_name} ${data.user.last_name})`);
  }

  saveAccounts();
  logInfo(`  [${account.label}] 刷新成功`);
}

function shouldRefresh(account) {
  if (!account.lastRefreshTime) return true;
  return (Date.now() - account.lastRefreshTime) / (1000 * 60 * 60) >= REFRESH_INTERVAL_HOURS;
}

// ======================== 公共接口 ========================

export async function initializeAuth(isReload = false) {
  if (isReload) logInfo('认证系统正在重新初始化...');

  authMode = 'client';
  factoryKeys = [];
  factoryKeyIndex = 0;
  accounts = [];
  accountIndex = 0;

  const authCfg = getAuthConfig();

  // 优先级 1: 固定密钥
  if (authCfg.factory_api_keys.length > 0) {
    authMode = 'factory_key';
    factoryKeys = authCfg.factory_api_keys;
    logInfo(`认证：固定密钥模式（${factoryKeys.length} 个轮询）`);
    return;
  }

  // 优先级 2: data/auth.json
  const saved = loadAccounts();
  if (saved.length > 0) {
    for (let i = 0; i < saved.length; i++) {
      const s = saved[i];
      accounts.push({
        refreshToken: s.refresh_token,
        accessToken: s.access_token || null,
        lastRefreshTime: s.last_updated ? new Date(s.last_updated).getTime() : null,
        label: s.label || `账户${i + 1}`,
        locked: s.locked || false,
        lockReason: s.lock_reason || null,
        lockTime: s.lock_time || null,
      });
    }
  }

  // 优先级 3: 环境变量（仅 data/auth.json 为空时）
  if (accounts.length === 0) {
    const envKeys = (process.env.DROID_REFRESH_KEY || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (envKeys.length > 0) {
      logInfo(`从环境变量导入 ${envKeys.length} 个初始令牌`);
      for (let i = 0; i < envKeys.length; i++) {
        accounts.push({
          refreshToken: envKeys[i], accessToken: null, lastRefreshTime: null,
          label: `账户${i + 1}`, locked: false, lockReason: null, lockTime: null,
        });
      }
    }
  }

  if (accounts.length > 0) {
    authMode = 'refresh';
    logInfo(`认证：刷新令牌模式（${accounts.length} 个账户）`);

    for (const account of accounts) {
      if (account.locked) {
        logInfo(`  [${account.label}] 已锁定: ${account.lockReason}`);
        continue;
      }
      try {
        if (account.accessToken && !shouldRefresh(account)) {
          logInfo(`  [${account.label}] access_token 有效，跳过刷新`);
        } else {
          await refreshAccount(account);
        }
      } catch (error) {
        logError(`  [${account.label}] 初始化失败: ${error.message}`);
      }
    }

    const available = accounts.filter((a) => a.accessToken && !a.locked);
    if (available.length > 0) {
      logInfo(`认证初始化完成（${available.length}/${accounts.length} 个可用）`);
    } else {
      logInfo('所有账户均不可用，降级为客户端授权模式');
      authMode = 'client';
    }
    return;
  }

  logInfo('认证：客户端授权模式（无密钥配置）');
}

/**
 * 获取 API Key（支持排除已锁定/指定索引的账户）
 * @param {string|null} clientAuth - 客户端 Authorization
 * @param {Set<number>} excludeIndices - 本次请求中需排除的账户索引
 * @returns {Promise<{authorization: string, accountIndex: number}>}
 */
export async function getApiKeyWithMeta(clientAuth = null, excludeIndices = new Set()) {
  // 固定密钥
  if (authMode === 'factory_key' && factoryKeys.length > 0) {
    const key = factoryKeys[factoryKeyIndex % factoryKeys.length];
    factoryKeyIndex++;
    return { authorization: `Bearer ${key}`, accountIndex: -1 };
  }

  // 刷新令牌轮询
  if (authMode === 'refresh' && accounts.length > 0) {
    for (let attempt = 0; attempt < accounts.length; attempt++) {
      const idx = (accountIndex + attempt) % accounts.length;
      if (excludeIndices.has(idx)) continue;

      const account = accounts[idx];
      if (account.locked) continue;

      try {
        if (shouldRefresh(account)) {
          await refreshAccount(account);
        }
        if (account.accessToken) {
          accountIndex = (idx + 1) % accounts.length;
          logDebug(`使用账户 [${account.label}]`);
          return { authorization: `Bearer ${account.accessToken}`, accountIndex: idx };
        }
      } catch (error) {
        logError(`账户 [${account.label}] 不可用`, error);
      }
    }
    // 所有账户都不可用时尝试客户端头
  }

  // 客户端授权
  if (clientAuth) {
    logDebug('使用客户端 Authorization 头');
    return { authorization: clientAuth, accountIndex: -1 };
  }

  throw new Error('无可用认证。请通过 /admin 添加令牌或在请求中携带 Authorization 头。');
}

/** 简版 getApiKey（兼容旧调用） */
export async function getApiKey(clientAuth = null) {
  const { authorization } = await getApiKeyWithMeta(clientAuth);
  return authorization;
}

/**
 * 锁定账户
 * @param {number} index - 账户索引
 * @param {string} reason - 锁定原因
 */
export function lockAccount(index, reason) {
  if (index < 0 || index >= accounts.length) return;
  const account = accounts[index];
  account.locked = true;
  account.lockReason = reason;
  account.lockTime = new Date().toISOString();
  saveAccounts();
  logInfo(`账户 [${account.label}] 已锁定: ${reason}`);
}

/**
 * 解锁账户
 * @param {number} index - 账户索引
 */
export function unlockAccount(index) {
  if (index < 0 || index >= accounts.length) return { success: false, message: '无效索引' };
  const account = accounts[index];
  account.locked = false;
  account.lockReason = null;
  account.lockTime = null;
  saveAccounts();

  // 如果从客户端模式恢复
  if (authMode === 'client' && accounts.some((a) => !a.locked && a.accessToken)) {
    authMode = 'refresh';
  }

  logInfo(`账户 [${account.label}] 已解锁`);
  return { success: true, message: `账户 [${account.label}] 已解锁` };
}

// ======================== API 管理 ========================

export async function addRefreshKey(refreshKey) {
  const account = {
    refreshToken: refreshKey.trim(), accessToken: null, lastRefreshTime: null,
    label: `账户${accounts.length + 1}`, locked: false, lockReason: null, lockTime: null,
  };
  await refreshAccount(account);
  accounts.push(account);
  if (authMode === 'client') authMode = 'refresh';
  logInfo(`新账户 [${account.label}] 已添加（共 ${accounts.length} 个）`);
  return { success: true, label: account.label, message: '令牌添加成功' };
}

export function removeRefreshKey(index) {
  if (index < 0 || index >= accounts.length) {
    return { success: false, message: `无效索引: ${index}` };
  }
  const removed = accounts.splice(index, 1)[0];
  saveAccounts();
  if (accountIndex >= accounts.length) accountIndex = 0;
  if (accounts.length === 0 && authMode === 'refresh') authMode = 'client';
  logInfo(`账户 [${removed.label}] 已删除（剩余 ${accounts.length} 个）`);
  return { success: true, message: `账户 [${removed.label}] 已删除` };
}

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
      locked: a.locked,
      lock_reason: a.lockReason,
      lock_time: a.lockTime,
    })),
  };
}
