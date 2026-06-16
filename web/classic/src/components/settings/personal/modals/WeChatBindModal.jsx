/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Image,
  Input,
  Modal,
  Spin,
  Tabs,
  TabPane,
} from '@douyinfe/semi-ui';
import { IconKey, IconRefresh } from '@douyinfe/semi-icons';
import { SiWechat } from 'react-icons/si';
import {
  createWechatBindQrcode,
  getWechatBindStatus,
  showError,
  showSuccess,
} from '../../../../helpers';

const DEFAULT_POLL_INTERVAL_SECONDS = 2;

const WeChatBindModal = ({
  t,
  showWeChatBindModal,
  setShowWeChatBindModal,
  inputs,
  handleInputChange,
  bindWeChat,
  status,
  onSuccess,
}) => {
  // Resolve which methods admin enabled — fall back to legacy `wechat_login`.
  const legacy = Boolean(status?.wechat_login);
  const scanEnabled = Boolean(status?.wechat_scan_login_enabled ?? legacy);
  const codeEnabled = Boolean(status?.wechat_code_login_enabled ?? legacy);
  const defaultMethod = status?.wechat_login_default_method === 'code' ? 'code' : 'scan';
  const initialTab = scanEnabled && codeEnabled ? defaultMethod : scanEnabled ? 'scan' : 'code';
  const [activeTab, setActiveTab] = useState(initialTab);
  useEffect(() => {
    if (showWeChatBindModal) setActiveTab(initialTab);
  }, [showWeChatBindModal, initialTab]);

  // ---- scan tab ----
  const [phase, setPhase] = useState('loading');
  const [qrImageUrl, setQrImageUrl] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const loginTokenRef = useRef('');
  const pollTimerRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const requestIdRef = useRef(0);
  const isFinishingRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const stopAll = useCallback(() => {
    clearTimers();
    requestIdRef.current += 1;
    loginTokenRef.current = '';
    isFinishingRef.current = false;
  }, [clearTimers]);

  const finishSuccess = useCallback(() => {
    if (isFinishingRef.current) return;
    isFinishingRef.current = true;
    clearTimers();
    showSuccess(t('微信绑定成功！'));
    if (typeof onSuccess === 'function') onSuccess();
    setShowWeChatBindModal(false);
  }, [clearTimers, onSuccess, setShowWeChatBindModal, t]);

  const pollOnce = useCallback(
    async (requestId) => {
      const token = loginTokenRef.current;
      if (!token || isFinishingRef.current) return;
      if (requestId !== requestIdRef.current) return;
      let res;
      try {
        res = await getWechatBindStatus(token);
      } catch (e) {
        return;
      }
      if (requestId !== requestIdRef.current) return;
      if (!res || !res.success) {
        if (res && !res.success) {
          clearTimers();
          setErrorMessage(res.message || t('微信绑定失败，请重试'));
          setPhase('error');
        }
        return;
      }
      const data = res.data || {};
      if (data.status === 'pending') return;
      if (data.status === 'expired') {
        clearTimers();
        setPhase('expired');
        return;
      }
      finishSuccess();
    },
    [clearTimers, finishSuccess, t],
  );

  const fetchQrCode = useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    isFinishingRef.current = false;
    setPhase('loading');
    setErrorMessage('');
    setQrImageUrl('');
    clearTimers();
    let res;
    try {
      res = await createWechatBindQrcode();
    } catch (e) {
      setErrorMessage(t('二维码加载失败'));
      setPhase('error');
      return;
    }
    if (requestId !== requestIdRef.current) return;
    if (!res || !res.success || !res.data) {
      setErrorMessage(res?.message || t('二维码加载失败'));
      setPhase('error');
      return;
    }
    loginTokenRef.current = res.data.login_token;
    setQrImageUrl(res.data.qrcode_image_url);
    const expire = Math.max(1, Math.floor(res.data.expire_seconds));
    setSecondsLeft(expire);
    setPhase('ready');
    countdownTimerRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearTimers();
          setPhase('expired');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    const pollInterval = Math.max(
      1,
      Math.floor(res.data.poll_interval_seconds || DEFAULT_POLL_INTERVAL_SECONDS),
    );
    pollTimerRef.current = setInterval(() => {
      pollOnce(requestId);
    }, pollInterval * 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearTimers, t]);

  useEffect(() => {
    if (showWeChatBindModal && activeTab === 'scan' && scanEnabled) {
      fetchQrCode();
    } else {
      stopAll();
    }
    return () => {
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWeChatBindModal, activeTab, scanEnabled]);

  const renderScanBody = () => (
    <div className='space-y-3 py-2 text-center'>
      <div
        style={{
          width: 220,
          height: 220,
          margin: '0 auto',
          background: '#f6f6f6',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {phase === 'loading' && <Spin />}
        {phase === 'ready' && qrImageUrl && (
          <Image
            src={qrImageUrl}
            alt={t('微信二维码')}
            preview={false}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        )}
        {phase === 'expired' && (
          <span className='text-gray-500'>{t('二维码已过期')}</span>
        )}
        {phase === 'error' && (
          <span className='text-gray-500 text-xs px-3'>
            {errorMessage || t('二维码加载失败')}
          </span>
        )}
      </div>
      <div className='text-gray-500 text-sm'>
        {phase === 'ready'
          ? t('二维码将在 {{seconds}} 秒后过期', { seconds: secondsLeft })
          : phase === 'expired' || phase === 'error'
          ? ' '
          : t('等待扫码...')}
      </div>
      {(phase === 'expired' || phase === 'error') && (
        <Button
          icon={<IconRefresh />}
          theme='light'
          onClick={fetchQrCode}
        >
          {t('重新获取二维码')}
        </Button>
      )}
      <div className='text-gray-500 text-xs'>
        {t('打开微信扫描二维码完成绑定')}
      </div>
    </div>
  );

  const renderCodeBody = () => (
    <div className='space-y-4 py-2 text-center'>
      {status?.wechat_qrcode ? (
        <Image src={status.wechat_qrcode} className='mx-auto' />
      ) : null}
      <div className='text-gray-600'>
        <p>
          {t('微信扫码关注公众号，输入「验证码」获取验证码（三分钟内有效）')}
        </p>
      </div>
      <Input
        placeholder={t('验证码')}
        name='wechat_verification_code'
        value={inputs.wechat_verification_code}
        onChange={(v) => handleInputChange('wechat_verification_code', v)}
        size='large'
        className='!rounded-lg'
        prefix={<IconKey />}
      />
      <Button
        type='primary'
        theme='solid'
        size='large'
        onClick={bindWeChat}
        className='!rounded-lg w-full !bg-slate-600 hover:!bg-slate-700'
        icon={<SiWechat size={16} />}
      >
        {t('绑定')}
      </Button>
    </div>
  );

  const noneEnabled = !scanEnabled && !codeEnabled;

  return (
    <Modal
      title={
        <div className='flex items-center'>
          <SiWechat className='mr-2 text-green-500' size={20} />
          {t('绑定微信账户')}
        </div>
      }
      visible={showWeChatBindModal}
      onCancel={() => {
        stopAll();
        setShowWeChatBindModal(false);
      }}
      footer={null}
      size={'small'}
      centered={true}
      className='modern-modal'
    >
      {noneEnabled ? (
        <div className='text-gray-500 text-center py-6'>
          {t('管理员未开启微信绑定')}
        </div>
      ) : scanEnabled && codeEnabled ? (
        <Tabs
          type='line'
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k)}
        >
          <TabPane tab={t('扫码绑定')} itemKey='scan'>
            {renderScanBody()}
          </TabPane>
          <TabPane tab={t('验证码绑定')} itemKey='code'>
            {renderCodeBody()}
          </TabPane>
        </Tabs>
      ) : scanEnabled ? (
        renderScanBody()
      ) : (
        renderCodeBody()
      )}
    </Modal>
  );
};

export default WeChatBindModal;
