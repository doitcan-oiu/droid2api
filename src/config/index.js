/**
 * @file 配置管理模块
 * @description 负责加载 YAML 配置文件，支持文件变更热加载
 *              配置文件路径：config/app.yaml
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { getCurrentUserAgent } from '../services/user-agent-updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 项目根目录 */
const ROOT_DIR = path.resolve(__dirname, '../../');

/** 配置文件路径 */
const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'app.yaml');

/** 当前配置对象 */
let config = null;

/** 配置变更回调列表 */
const changeCallbacks = [];

/**
 * 加载 YAML 配置文件
 * @returns {object} 解析后的配置对象
 * @throws {Error} 配置文件不存在或格式错误时抛出异常
 */
export function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    config = yaml.load(raw);

    // 兼容旧字段：将 endpoint 映射为 endpoints
    if (config.endpoint && !config.endpoints) {
      config.endpoints = config.endpoint;
    }

    return config;
  } catch (error) {
    throw new Error(`加载配置文件失败 (${CONFIG_PATH}): ${error.message}`);
  }
}

/**
 * 获取当前配置（未加载时自动加载）
 * @returns {object} 配置对象
 */
export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

/**
 * 初始化配置热加载
 * 监听 config/app.yaml 文件变更，自动重新加载配置
 */
export function initHotReload() {
  // 防抖定时器，避免频繁触发
  let debounceTimer = null;

  try {
    fs.watch(CONFIG_PATH, (eventType) => {
      if (eventType === 'change') {
        // 使用防抖，500ms 内多次变更只触发一次
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            const oldConfig = { ...config };
            loadConfig();
            console.log('[INFO] 配置文件已热加载');

            // 触发所有变更回调
            for (const cb of changeCallbacks) {
              try {
                cb(config, oldConfig);
              } catch (e) {
                console.error('[ERROR] 配置变更回调执行失败:', e.message);
              }
            }
          } catch (error) {
            console.error('[ERROR] 热加载配置失败，保持原配置:', error.message);
          }
        }, 500);
      }
    });
    console.log('[INFO] 配置热加载已启用，监听文件: config/app.yaml');
  } catch (error) {
    console.error('[WARN] 配置热加载启用失败:', error.message);
  }
}

/**
 * 注册配置变更回调
 * @param {Function} callback - 回调函数，参数为 (newConfig, oldConfig)
 */
export function onConfigChange(callback) {
  if (typeof callback === 'function') {
    changeCallbacks.push(callback);
  }
}

/**
 * 根据模型ID获取模型配置
 * @param {string} modelId - 模型ID
 * @returns {object|undefined} 模型配置对象
 */
export function getModelById(modelId) {
  const cfg = getConfig();
  return cfg.models.find(m => m.id === modelId);
}

/**
 * 根据类型获取 API 端点配置
 * @param {string} type - 端点类型 (openai / anthropic / common)
 * @returns {object|undefined} 端点配置对象
 */
export function getEndpointByType(type) {
  const cfg = getConfig();
  return cfg.endpoints.find(e => e.name === type);
}

/**
 * 判断是否为开发模式
 * @returns {boolean}
 */
export function isDevMode() {
  const cfg = getConfig();
  return cfg.dev_mode === true;
}

/**
 * 获取服务监听端口
 * @returns {number}
 */
export function getPort() {
  const cfg = getConfig();
  return cfg.port || 3000;
}

/**
 * 获取系统提示词
 * @returns {string}
 */
export function getSystemPrompt() {
  const cfg = getConfig();
  return cfg.system_prompt || '';
}

/**
 * 获取模型的推理级别配置
 * @param {string} modelId - 模型ID
 * @returns {string|null} 推理级别 (auto/off/low/medium/high/xhigh)
 */
export function getModelReasoning(modelId) {
  const model = getModelById(modelId);
  if (!model || !model.reasoning) {
    return null;
  }
  const level = String(model.reasoning).toLowerCase();
  if (['low', 'medium', 'high', 'xhigh', 'auto'].includes(level)) {
    return level;
  }
  return null;
}

/**
 * 获取模型的提供商标识
 * @param {string} modelId - 模型ID
 * @returns {string|null}
 */
export function getModelProvider(modelId) {
  const model = getModelById(modelId);
  return model?.provider || null;
}

/**
 * 判断模型是否启用 fast 模式
 * @param {string} modelId - 模型ID
 * @returns {boolean}
 */
export function getModelFast(modelId) {
  const model = getModelById(modelId);
  return model?.fast === true;
}

/**
 * 获取重试与锁定配置
 * @returns {object} { maxRetries: number, lockStatusCodes: number[] }
 */
export function getRetryConfig() {
  const cfg = getConfig();
  return {
    maxRetries: cfg.retry?.max_retries ?? 3,
    lockStatusCodes: Array.isArray(cfg.lock_status_codes) ? cfg.lock_status_codes : [402],
  };
}

/**
 * 获取当前 User-Agent 字符串
 * @returns {string}
 */
export function getUserAgent() {
  return getCurrentUserAgent();
}

/**
 * 获取代理配置列表
 * @returns {Array} 代理配置数组
 */
export function getProxyConfigs() {
  const cfg = getConfig();
  if (!Array.isArray(cfg.proxies)) {
    return [];
  }
  return cfg.proxies.filter(proxy => proxy && typeof proxy === 'object');
}

/**
 * 获取模型重定向后的ID
 * 如果配置了重定向映射，返回映射后的ID
 * @param {string} modelId - 原始模型ID
 * @returns {string} 重定向后的模型ID
 */
export function getRedirectedModelId(modelId) {
  const cfg = getConfig();
  if (cfg.model_redirects && cfg.model_redirects[modelId]) {
    const redirectedId = cfg.model_redirects[modelId];
    console.log(`[REDIRECT] 模型重定向: ${modelId} -> ${redirectedId}`);
    return redirectedId;
  }
  return modelId;
}

/**
 * 获取认证配置（合并 YAML 配置与环境变量，去重）
 * 仅管理 factory_api_keys，刷新令牌由 data/auth.json + API 管理
 * @returns {object} { factory_api_keys: string[] }
 */
export function getAuthConfig() {
  const cfg = getConfig();
  const authCfg = cfg.auth || {};

  // 从环境变量解析（逗号分隔）
  const envFactoryKeys = (process.env.FACTORY_API_KEY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // 从配置文件获取
  const yamlFactoryKeys = Array.isArray(authCfg.factory_api_keys)
    ? authCfg.factory_api_keys.filter(Boolean)
    : [];

  // 合并去重
  const factory_api_keys = [...new Set([...envFactoryKeys, ...yamlFactoryKeys])];

  return { factory_api_keys };
}

/** 导出项目根目录和配置路径供其他模块使用 */
export { ROOT_DIR, CONFIG_PATH };
