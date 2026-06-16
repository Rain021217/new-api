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
import { Button, Modal, Spin } from '@douyinfe/semi-ui';
import Text from '@douyinfe/semi-ui/lib/es/typography/text';
import { IconRefresh } from '@douyinfe/semi-icons';
import { useTranslation } from 'react-i18next';
import {
  createWechatLoginQrcode,
  getWechatLoginStatus,
  showError,
  showSuccess,
} from '../../helpers';

const DEFAULT_POLL_INTERVAL_SECONDS = 2;

/**
 * WeChat scan-login modal (Semi Design).
 *
 * @param {boolean} visible        whether the modal is open
 * @param {function} onClose       called to close the modal
 * @param {string}   affCode       affiliate code forwarded to the QR request
 * @param {function} onLoginSuccess called with the standard login `data`
 *                                  payload; reuse the parent's existing
 *                                  password-login success handler.
 * @param {function} onRequire2FA  called when the poll result requires 2FA.
 */
const WeChatScanLoginModal = ({
  visible,
  onClose,
  affCode,
  onLoginSuccess,
  onRequire2FA,
}) => {
  const { t } = useTranslation();
  // phase: 'loading' | 'ready' | 'expired' | 'error'
  const [phase, setPhase] = useState('loading');
  const [qrImageUrl, setQrImageUrl] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');

  // Refs so the async poll loop and timers always see live values without
  // re-subscribing, and so cleanup can stop everything on close/unmount.
  const loginTokenRef = useRef('');
  const pollTimerRef = useRef(null);
  const countdownTimerRef = useRef(null);
  // Bumped on every (re)fetch and on close; stale async callbacks compare
  // against it and bail so a late response can't revive a closed modal.
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
  }, [clearTimers]);

  const pollOnce = useCallback(
    async (requestId) => {
      const loginToken = loginTokenRef.current;
      if (!loginToken || isFinishingRef.current) return;
      if (requestId !== requestIdRef.current) return;

      let res;
      try {
        res = await getWechatLoginStatus(loginToken);
      } catch (error) {
        // Transient error — keep polling.
        return;
      }

      // Modal was closed/refreshed while the request was in flight.
      if (requestId !== requestIdRef.current || isFinishingRef.current) return;
      if (!res?.success) return;

      const status = res.data?.status;
      if (status === 'pending') return;
      if (status === 'expired') {
        clearTimers();
        setSecondsLeft(0);
        setPhase('expired');
        return;
      }

      // Anything else is a login result (same shape as password login).
      isFinishingRef.current = true;
      clearTimers();

      if (res.data?.require_2fa) {
        onRequire2FA();
        return;
      }

      try {
        await onLoginSuccess(res.data ?? null);
        showSuccess(t('登录成功！'));
        onClose();
      } catch (error) {
        // Surface a generic failure but allow the user to retry.
        isFinishingRef.current = false;
        showError(t('登录失败，请重试'));
      }
    },
    [clearTimers, onClose, onLoginSuccess, onRequire2FA, t],
  );

  const fetchQrCode = useCallback(async () => {
    clearTimers();
    const requestId = (requestIdRef.current += 1);
    isFinishingRef.current = false;
    loginTokenRef.current = '';
    setPhase('loading');
    setQrImageUrl('');
    setErrorMessage('');
    setSecondsLeft(0);

    try {
      const res = await createWechatLoginQrcode(affCode);
      // A newer fetch (or a close) superseded this one.
      if (requestId !== requestIdRef.current) return;

      if (
        !res?.success ||
        !res.data?.login_token ||
        !res.data?.qrcode_image_url
      ) {
        setErrorMessage(res?.message || t('二维码加载失败'));
        setPhase('error');
        return;
      }

      const { login_token, qrcode_image_url, expire_seconds } = res.data;
      const pollInterval =
        res.data.poll_interval_seconds && res.data.poll_interval_seconds > 0
          ? res.data.poll_interval_seconds
          : DEFAULT_POLL_INTERVAL_SECONDS;

      loginTokenRef.current = login_token;
      setQrImageUrl(qrcode_image_url);
      setPhase('ready');

      // Countdown derived from the server-reported expiry.
      const total = expire_seconds && expire_seconds > 0 ? expire_seconds : 0;
      setSecondsLeft(total);
      if (total > 0) {
        countdownTimerRef.current = setInterval(() => {
          setSecondsLeft((prev) => {
            if (prev <= 1) {
              if (countdownTimerRef.current !== null) {
                clearInterval(countdownTimerRef.current);
                countdownTimerRef.current = null;
              }
              // Stop polling and surface the re-fetch action.
              if (pollTimerRef.current !== null) {
                clearInterval(pollTimerRef.current);
                pollTimerRef.current = null;
              }
              setPhase('expired');
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      }

      // Polling loop.
      pollTimerRef.current = setInterval(() => {
        pollOnce(requestId);
      }, pollInterval * 1000);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setErrorMessage(t('二维码加载失败'));
      setPhase('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pollOnce only reads refs; excluding it keeps fetchQrCode stable so the QR isn't refetched on every parent re-render (mirrors the default theme)
  }, [affCode, clearTimers, t]);

  // Start polling when opened; tear everything down when closed/unmounted.
  useEffect(() => {
    if (visible) {
      fetchQrCode();
    } else {
      stopAll();
      isFinishingRef.current = false;
    }
    return () => {
      stopAll();
    };
  }, [visible, fetchQrCode, stopAll]);

  const showCountdown = phase === 'ready' && secondsLeft > 0;

  return (
    <Modal
      title={t('微信扫码登录')}
      visible={visible}
      maskClosable={true}
      onCancel={onClose}
      footer={null}
      centered={true}
      width={400}
    >
      <div className='flex flex-col items-center'>
        <Text type='tertiary' className='mb-4 text-center'>
          {t('打开微信扫描二维码登录')}
        </Text>

        <div
          className='relative flex items-center justify-center overflow-hidden rounded-md border border-gray-200 bg-gray-50'
          style={{ width: 192, height: 192 }}
        >
          {phase === 'ready' && qrImageUrl ? (
            <img
              src={qrImageUrl}
              alt={t('微信扫码登录')}
              className='h-full w-full object-contain'
            />
          ) : phase === 'loading' ? (
            <Spin size='large' />
          ) : (
            // expired / error: dim the area and offer a refresh button.
            <div className='flex flex-col items-center gap-2 px-3 text-center'>
              <Text type='tertiary'>
                {phase === 'error'
                  ? errorMessage || t('二维码加载失败')
                  : t('二维码已过期')}
              </Text>
              <Button
                theme='outline'
                type='tertiary'
                size='small'
                icon={<IconRefresh />}
                onClick={fetchQrCode}
              >
                {t('重新获取二维码')}
              </Button>
            </div>
          )}
        </div>

        <div className='mt-4 text-center'>
          {showCountdown ? (
            <Text size='small' type='tertiary'>
              {t('二维码将在 {{seconds}} 秒后过期', { seconds: secondsLeft })}
            </Text>
          ) : phase === 'ready' ? (
            <Text size='small' type='tertiary'>
              {t('等待扫码...')}
            </Text>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default WeChatScanLoginModal;
