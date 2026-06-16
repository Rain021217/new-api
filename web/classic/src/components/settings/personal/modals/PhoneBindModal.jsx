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

import React from 'react';
import { Button, Input, Modal } from '@douyinfe/semi-ui';
import { IconKey } from '@douyinfe/semi-icons';
import { Smartphone } from 'lucide-react';

const PhoneBindModal = ({
  t,
  showPhoneBindModal,
  setShowPhoneBindModal,
  inputs,
  handleInputChange,
  sendPhoneVerificationCode,
  bindPhone,
  phoneDisableButton,
  phoneLoading,
  phoneCountdown,
}) => {
  return (
    <Modal
      title={
        <div className='flex items-center'>
          <Smartphone size={16} className='mr-2 text-blue-500' />
          {t('绑定手机号')}
        </div>
      }
      visible={showPhoneBindModal}
      onCancel={() => setShowPhoneBindModal(false)}
      onOk={bindPhone}
      size={'small'}
      centered={true}
      maskClosable={false}
      className='modern-modal'
    >
      <div className='space-y-4 py-4'>
        <div className='flex gap-3'>
          <Input
            placeholder={t('输入手机号')}
            value={inputs.phone}
            onChange={(value) => handleInputChange('phone', value)}
            name='phone'
            type='tel'
            size='large'
            className='!rounded-lg flex-1'
            prefix={<Smartphone size={14} />}
          />
          <Button
            onClick={sendPhoneVerificationCode}
            disabled={phoneDisableButton || phoneLoading}
            className='!rounded-lg'
            type='primary'
            theme='outline'
            size='large'
          >
            {phoneDisableButton
              ? `${t('重新发送')} (${phoneCountdown})`
              : t('获取验证码')}
          </Button>
        </div>

        <Input
          placeholder={t('验证码')}
          name='phone_verification_code'
          value={inputs.phone_verification_code}
          onChange={(value) =>
            handleInputChange('phone_verification_code', value)
          }
          size='large'
          className='!rounded-lg'
          prefix={<IconKey />}
          maxLength={6}
        />
      </div>
    </Modal>
  );
};

export default PhoneBindModal;
