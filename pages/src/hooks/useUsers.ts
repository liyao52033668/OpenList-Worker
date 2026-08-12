import { useState, useCallback } from 'react';
import axios from 'axios';
import { useAuthStore } from '../store';
import type { UsersResult, LoginRequest, CreateUserRequest, UpdateUserRequest } from '../types'

// 新版 API 基础路径（与 GO 后端对齐）
const API_AUTH   = '/api/auth';
const API_ADMIN  = '/api/admin/user';
const API_ME     = '/api/me';

export const useUsers = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 获取认证token（与 apiService 统一从 zustand 读取，避免读到不存在的 localStorage key）
  const getAuthToken = () => {
    return useAuthStore.getState().token;
  };

  // 设置认证token
  const setAuthToken = (token: string) => {
    useAuthStore.setState({ token });
  };

  // 清除认证token
  const clearAuthToken = () => {
    useAuthStore.setState({ token: null });
  };

  // 获取认证头
  const getAuthHeaders = () => {
    const token = getAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  // 处理API响应（兼容新版 {code, message, data} 与旧版 {flag, text, data} 格式）
  const handleResponse = (response: any): UsersResult => {
    const body = response?.data;
    if (body && typeof body === 'object') {
      if (body.hasOwnProperty('code') && body.hasOwnProperty('message')) {
        // 新版 Go 后端格式：{code, message, data}
        if (body.code === 200) {
          const payload = body.data;
          // 兼容分页结构 {content, total} → 返回 content 数组
          if (payload && Array.isArray(payload.content)) {
            return { flag: true, text: body.message || 'success', data: payload.content };
          }
          return { flag: true, text: body.message || 'success', data: payload };
        }
        return { flag: false, text: body.message || '请求失败', code: body.code };
      }
      if (body.hasOwnProperty('flag')) {
        // 旧版格式
        return body as UsersResult;
      }
    }
    return {
      flag: false,
      text: '响应格式错误'
    };
  };

  // 处理API错误
  const handleError = (err: any): UsersResult => {
    console.error('API Error:', err);
    // 新版错误为 {code, message}，旧版为 {flag, text}
    const errorMessage = err.response?.data?.message || err.response?.data?.text || err.message || '网络错误';
    setError(errorMessage);
    return {
      flag: false,
      text: errorMessage
    };
  };

  // 用户登录
  const login = useCallback(async (loginData: LoginRequest): Promise<UsersResult> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await axios.post(`${API_AUTH}/login`, loginData);
      const result = handleResponse(response);
      // 新版格式 token 位于 data.token
      const token = result.token || (result.data as any)?.token;

      if (result.flag && token) {
        setAuthToken(token);
      }

      return result;
    } catch (err) {
      return handleError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 用户登出
  const logout = useCallback(async (): Promise<UsersResult> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await axios.get(`${API_AUTH}/logout`, {
        headers: getAuthHeaders()
      });
      const result = handleResponse(response);
      
      if (result.flag) {
        clearAuthToken();
      }
      
      return result;
    } catch (err) {
      clearAuthToken(); // 即使请求失败也清除本地token
      return handleError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 获取用户列表（管理员）
  const getUsers = useCallback(async (username?: string): Promise<UsersResult> => {
    setLoading(true);
    setError(null);
    
    try {
      const url = username
        ? `${API_ADMIN}/list?username=${encodeURIComponent(username)}`
        : `${API_ADMIN}/list`;
      
      const response = await axios.get(url, {
        headers: getAuthHeaders()
      });
      
      return handleResponse(response);
    } catch (err) {
      return handleError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 创建用户（管理员）
  const createUser = useCallback(async (userData: CreateUserRequest): Promise<UsersResult> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await axios.post(`${API_ADMIN}/create`, userData, {
        headers: getAuthHeaders()
      });
      
      return handleResponse(response);
    } catch (err) {
      return handleError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 更新用户信息
  const updateUser = useCallback(async (userData: UpdateUserRequest): Promise<UsersResult> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await axios.post(`${API_ADMIN}/update`, userData, {
        headers: getAuthHeaders()
      });
      
      return handleResponse(response);
    } catch (err) {
      return handleError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 删除用户（管理员）
  const deleteUser = useCallback(async (username: string): Promise<UsersResult> => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await axios.post(`${API_ADMIN}/delete`, {
        username
      }, {
        headers: getAuthHeaders()
      });
      
      return handleResponse(response);
    } catch (err) {
      return handleError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // 验证当前用户权限（获取当前登录用户信息）
  const checkAuth = useCallback(async (): Promise<UsersResult> => {
    const token = getAuthToken();
    if (!token) {
      return {
        flag: false,
        text: '用户未登录'
      };
    }

    setLoading(true);
    setError(null);
    
    try {
      const response = await axios.get(`${API_ME}`, {
        headers: getAuthHeaders()
      });
      
      return handleResponse(response);
    } catch (err) {
      clearAuthToken(); // token无效时清除
      return handleError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    login,
    logout,
    getUsers,
    createUser,
    updateUser,
    deleteUser,
    checkAuth,
    getAuthToken,
    setAuthToken,
    clearAuthToken
  };
};

export default useUsers;