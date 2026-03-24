/**
 * @file 认证服务模块
 * @description 管理 API 密钥的获取与刷新，支持多账户轮询
 *
 *  设计理念：
 *    config/app.yaml  → 唯一配置来源（定义账户列表）
 *    data/auth.json   → 纯运行时状态（存储各账户刷新后的最新令牌）
 *
 *  认证优先级：factory_api_keys > refresh_keys > 客户端 Authorization
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

/** 固定 API Key 列表（factory_api_keys 模式） */
let factoryKeys = [];
/** 固定 Key 轮询索引 */
let factoryKeyIndex = 0;

/**
 * 刷新账户列表
 * 每个账户结构: { seed, accessToken, refreshToken, lastRefreshTime, label }
 *   seed          - 配置文件中的初始 refresh_token（用于标识账户）
 *   accessToken   - 当前有效的 access_token
 *   refreshToken  - 最新的 refresh_token（一次性，每次刷新后更新）
 *   lastRefreshTime - 上次刷新的时间戳
 *   label         - 显示标签（邮箱或序号）
 */
let accounts = [];
/** 刷新账户轮询索引 */
let accountIndex = 0;

// ======================== 运行时状态持久化 ========================

/**
 * 加载运行时令牌状态
 * @returns {object} 以 seed token 为 key 的状态映射
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch (error) {
    logDebug('读取 data/auth.json 失败', error);
  }
  return {};
}

/**
 * 保存运行时令牌状态
 * @param {object} state - 状态对象
 */
function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    logError('保存 data/auth.json 失败', error);
  }
}

/**
 * 保存单个账户的令牌到运行时状态文件
 * @param {object} account - 账户对象
 */
function persistAccount(account) {
  const state = loadState();
  state[account.seed] = {
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    last_updated: new Date().toISOString(),
    label: account.label || '',
  };
  saveState(state);
}

// ======================== 令牌刷新 ========================

/**
 * 刷新指定账户的 API Key
 * @param {object} account - 账户对象
 * @returns {Promise<void>}
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

  // 更新标签（使用邮箱）
  if (data.user?.email) {
    account.label = data.user.email;
  }

  // 输出用户信息
  if (data.user) {
    logInfo(`  用户: ${data.user.email} (${data.user.first_name} ${data.user.last_name})`);
  }

  // 持久化到 data/auth.json
  persistAccount(account);

  logInfo(`  账户 [${account.label}] 刷新成功`);
}

/**
 * 判断账户是否需要刷新（超过 6 小时）
 * @param {object} account - 账户对象
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
 * @param {boolean} [isReload=false] - 是否为热加载触发的重新初始化
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

  // ---- 优先级 2: 刷新令牌 ----
  if (authCfg.refresh_keys.length > 0) {
    authMode = 'refresh';
    const state = loadState();

    // 为每个 seed token 创建账户对象
    for (let i = 0; i < authCfg.refresh_keys.length; i++) {
      const seed = authCfg.refresh_keys[i];
      const cached = state[seed] || {};

      accounts.push({
        seed,
        accessToken: cached.access_token || null,
        refreshToken: cached.refresh_token || seed, // 有缓存用缓存，没有用初始种子
        lastRefreshTime: cached.last_updated ? new Date(cached.last_updated).getTime() : null,
        label: cached.label || `账户${i + 1}`,
      });
    }

    logInfo(`认证系统：刷新令牌模式（${accounts.length} 个账户轮询）`);

    // 逐个初始化需要刷新的账户
    for (const account of accounts) {
      try {
        if (account.accessToken && !shouldRefresh(account)) {
          logInfo(`  [${account.label}] access_token 仍在有效期内，跳过刷新`);
        } else {
          await refreshAccount(account);
        }
      } catch (error) {
        logError(`  [${account.label}] 初始化失败: ${error.message}`);
        // 单个账户失败不阻塞启动，继续尝试下一个
      }
    }

    // 检查是否有任何账户可用
    const availableAccounts = accounts.filter((a) => a.accessToken);
    if (availableAccounts.length > 0) {
      logInfo(`认证系统初始化完成（${availableAccounts.length}/${accounts.length} 个账户可用）`);
    } else {
      // 所有账户都不可用，降级为客户端授权模式
      logInfo('所有刷新令牌账户均不可用，降级为客户端授权模式');
      logInfo('提示: 可通过环境变量 DROID_REFRESH_KEY 设置有效令牌，或在请求中携带 Authorization 头');
      authMode = 'client';
    }
    return;
  }

  // ---- 优先级 3: 客户端授权 ----
  logInfo('认证系统已初始化：客户端授权模式（无密钥配置）');
}

/**
 * 获取 API Key（支持多账户轮询）
 * @param {string|null} clientAuthorization - 客户端请求头中的 Authorization 值
 * @returns {Promise<string>} 格式为 "Bearer xxx" 的认证字符串
 * @throws {Error} 无可用认证时抛出异常
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
    // 找到一个可用的账户（轮询，最多尝试全部账户）
    for (let attempt = 0; attempt < accounts.length; attempt++) {
      const idx = (accountIndex + attempt) % accounts.length;
      const account = accounts[idx];

      try {
        // 需要刷新时自动刷新
        if (shouldRefresh(account)) {
          logInfo(`账户 [${account.label}] 的 access_token 已过期，正在刷新...`);
          await refreshAccount(account);
        }

        if (account.accessToken) {
          // 推进轮询索引到下一个
          accountIndex = (idx + 1) % accounts.length;
          logDebug(`使用账户 [${account.label}] 的 API Key`);
          return `Bearer ${account.accessToken}`;
        }
      } catch (error) {
        logError(`账户 [${account.label}] 获取 API Key 失败`, error);
        // 尝试下一个账户
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
    '无可用认证。请在 config/app.yaml 中配置 factory_api_keys 或 refresh_keys，或在请求中提供 Authorization 头。'
  );
}
