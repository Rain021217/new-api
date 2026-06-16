/*
Copyright (C) 2023-2026 QuantumNous

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
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useCountdown } from '@/hooks/use-countdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog } from '@/components/dialog'
import { sendPhoneBindCode, bindPhone } from '../../api'

interface PhoneBindDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentPhone?: string
  onSuccess: () => void
}

export function PhoneBindDialog({
  open,
  onOpenChange,
  currentPhone,
  onSuccess,
}: PhoneBindDialogProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const {
    secondsLeft,
    isActive,
    start: startCountdown,
    reset: resetCountdown,
  } = useCountdown({ initialSeconds: 60 })

  const handleSendCode = async () => {
    if (!phone || phone.trim().length < 6) {
      toast.error(t('Please enter a valid phone number'))
      return
    }
    try {
      setSendingCode(true)
      const res = await sendPhoneBindCode(phone.trim())
      if (res.success) {
        toast.success(t('Verification code sent to your phone'))
        startCountdown()
      } else {
        toast.error(res.message || t('Failed to send verification code'))
      }
    } catch (_error) {
      toast.error(t('Failed to send verification code'))
    } finally {
      setSendingCode(false)
    }
  }

  const handleBind = async () => {
    if (!phone || !code) {
      toast.error(t('Please enter phone and verification code'))
      return
    }
    try {
      setLoading(true)
      const res = await bindPhone(phone.trim(), code.trim())
      if (res.success) {
        toast.success(t('Phone bound successfully!'))
        onOpenChange(false)
        onSuccess()
        setPhone('')
        setCode('')
        resetCountdown()
      } else {
        toast.error(res.message || t('Failed to bind phone'))
      }
    } catch (_error) {
      toast.error(t('Failed to bind phone'))
    } finally {
      setLoading(false)
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (loading) return
    onOpenChange(next)
    if (!next) {
      setPhone('')
      setCode('')
      resetCountdown()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('Bind Phone')}
      description={
        currentPhone
          ? t('Current phone: {{phone}}. Enter a new phone to change.', {
              phone: currentPhone,
            })
          : t('Bind a phone number to your account.')
      }
      contentClassName='sm:max-w-md'
      contentHeight='auto'
      bodyClassName='space-y-4'
      footer={
        <>
          <Button
            type='button'
            variant='outline'
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            {t('Cancel')}
          </Button>
          <Button
            type='button'
            onClick={handleBind}
            disabled={loading || !phone || !code}
          >
            {loading && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
            {loading ? t('Binding...') : t('Bind Phone')}
          </Button>
        </>
      }
    >
      <div className='space-y-4 py-4'>
        <div className='space-y-2'>
          <Label htmlFor='phone'>{t('Phone Number')}</Label>
          <Input
            id='phone'
            type='tel'
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t('Enter your phone number')}
            disabled={loading}
            autoComplete='tel'
          />
        </div>
        <div className='space-y-2'>
          <Label htmlFor='phone-code'>{t('Verification Code')}</Label>
          <div className='flex gap-2'>
            <Input
              id='phone-code'
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('Enter code')}
              disabled={loading}
              maxLength={6}
              inputMode='numeric'
            />
            <Button
              type='button'
              variant='outline'
              onClick={handleSendCode}
              disabled={sendingCode || isActive || !phone}
            >
              {isActive
                ? `${secondsLeft}s`
                : sendingCode
                  ? t('Sending...')
                  : t('Send')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
