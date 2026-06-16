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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog } from '@/components/dialog'
import { useStatus } from '@/hooks/use-status'
import type { SystemStatus } from '@/features/auth/types'
import {
  bindWeChat,
  createWechatBindQrcode,
  getWechatBindStatus,
} from '../../api'

interface WeChatBindDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

type ScanPhase = 'loading' | 'ready' | 'expired' | 'error'
type TabKey = 'scan' | 'code'

const DEFAULT_POLL_INTERVAL_SECONDS = 2

function resolveMethods(status: SystemStatus | null) {
  const legacy = Boolean(status?.wechat_login)
  const scan = Boolean(status?.wechat_scan_login_enabled ?? legacy)
  const code = Boolean(status?.wechat_code_login_enabled ?? legacy)
  const defaultMethod: TabKey =
    status?.wechat_login_default_method === 'code' ? 'code' : 'scan'
  return { scan, code, defaultMethod }
}

function readStaticQrCode(status: SystemStatus | null): string {
  return (
    (status?.wechat_qrcode as string | undefined) ||
    (status?.wechat_qr_code as string | undefined) ||
    ''
  )
}

export function WeChatBindDialog({
  open,
  onOpenChange,
  onSuccess,
}: WeChatBindDialogProps) {
  const { t } = useTranslation()
  const { status } = useStatus()
  const methods = useMemo(() => resolveMethods(status), [status])
  const staticQrCode = useMemo(() => readStaticQrCode(status), [status])

  const initialTab: TabKey =
    methods.scan && methods.code
      ? methods.defaultMethod
      : methods.scan
        ? 'scan'
        : 'code'
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab)
  useEffect(() => {
    if (open) setActiveTab(initialTab)
  }, [open, initialTab])

  // ---------- scan tab state ----------
  const [phase, setPhase] = useState<ScanPhase>('loading')
  const [imageUrl, setImageUrl] = useState<string>('')
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const requestIdRef = useRef(0)
  const isFinishingRef = useRef(false)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const loginTokenRef = useRef<string | null>(null)

  const clearTimers = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }, [])

  const stopAll = useCallback(() => {
    clearTimers()
    requestIdRef.current += 1
    loginTokenRef.current = null
    isFinishingRef.current = false
  }, [clearTimers])

  const finishSuccess = useCallback(() => {
    if (isFinishingRef.current) return
    isFinishingRef.current = true
    clearTimers()
    toast.success(t('Bound WeChat'))
    onSuccess()
    onOpenChange(false)
  }, [clearTimers, onOpenChange, onSuccess, t])

  const pollOnce = useCallback(
    async (requestId: number) => {
      if (requestId !== requestIdRef.current) return
      const token = loginTokenRef.current
      if (!token) return
      const res = await getWechatBindStatus(token).catch(() => null)
      if (requestId !== requestIdRef.current) return
      if (!res || !res.success) {
        // Soft errors (transport hiccup, invalid session) — surface a friendly state.
        if (res && !res.success) {
          setErrorMessage(res.message || t('Failed to bind WeChat'))
          setPhase('error')
          clearTimers()
        }
        return
      }
      const data = res.data as { status?: string } | null
      if (data?.status === 'pending') return
      if (data?.status === 'expired') {
        clearTimers()
        setPhase('expired')
        return
      }
      // success
      finishSuccess()
    },
    [clearTimers, finishSuccess, t]
  )

  const fetchQrCode = useCallback(async () => {
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    isFinishingRef.current = false
    setPhase('loading')
    setErrorMessage('')
    setImageUrl('')
    clearTimers()
    const res = await createWechatBindQrcode().catch(() => null)
    if (requestId !== requestIdRef.current) return
    if (!res || !res.success || !res.data) {
      setErrorMessage(res?.message || t('Failed to load QR code'))
      setPhase('error')
      return
    }
    loginTokenRef.current = res.data.login_token
    setImageUrl(res.data.qrcode_image_url)
    const expire = Math.max(1, Math.floor(res.data.expire_seconds))
    setSecondsLeft(expire)
    setPhase('ready')
    countdownTimerRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearTimers()
          setPhase('expired')
          return 0
        }
        return prev - 1
      })
    }, 1000)
    const pollInterval = Math.max(
      1,
      Math.floor(res.data.poll_interval_seconds || DEFAULT_POLL_INTERVAL_SECONDS)
    )
    pollTimerRef.current = setInterval(() => {
      pollOnce(requestId)
    }, pollInterval * 1000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearTimers, t])

  useEffect(() => {
    if (open && activeTab === 'scan' && methods.scan) {
      fetchQrCode()
    } else {
      stopAll()
    }
    return () => {
      stopAll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeTab, methods.scan])

  // ---------- code tab state ----------
  const [verificationCode, setVerificationCode] = useState('')
  const [submittingCode, setSubmittingCode] = useState(false)
  useEffect(() => {
    if (!open) setVerificationCode('')
  }, [open])

  const handleSubmitCode = async () => {
    if (!verificationCode.trim()) {
      toast.error(t('Please enter the verification code'))
      return
    }
    setSubmittingCode(true)
    try {
      const res = await bindWeChat(verificationCode.trim())
      if (res.success) {
        toast.success(t('Bound WeChat'))
        onSuccess()
        onOpenChange(false)
        setVerificationCode('')
      } else {
        toast.error(res.message || t('Failed to bind WeChat'))
      }
    } catch {
      toast.error(t('Failed to bind WeChat'))
    } finally {
      setSubmittingCode(false)
    }
  }

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      stopAll()
      setVerificationCode('')
    }
  }

  const showTabs = methods.scan && methods.code
  const onlyScan = methods.scan && !methods.code
  const onlyCode = methods.code && !methods.scan

  const renderScanBody = () => (
    <div className='flex flex-col items-center gap-3 py-2'>
      <div className='border-border bg-muted/30 relative flex h-56 w-56 items-center justify-center overflow-hidden rounded-lg border'>
        {phase === 'loading' && (
          <Loader2 className='text-muted-foreground h-8 w-8 animate-spin' />
        )}
        {phase === 'ready' && imageUrl && (
          <img
            src={imageUrl}
            alt={t('WeChat QR code')}
            className='h-full w-full object-contain p-2'
          />
        )}
        {phase === 'expired' && (
          <div className='text-muted-foreground text-sm'>
            {t('QR code expired')}
          </div>
        )}
        {phase === 'error' && (
          <div className='text-muted-foreground p-4 text-center text-xs'>
            {errorMessage || t('Failed to load QR code')}
          </div>
        )}
      </div>
      <p className='text-muted-foreground text-xs'>
        {phase === 'ready'
          ? t('QR code expires in {{seconds}}s', { seconds: secondsLeft })
          : phase === 'expired' || phase === 'error'
            ? ' '
            : t('Waiting for scan…')}
      </p>
      {(phase === 'expired' || phase === 'error') && (
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={() => fetchQrCode()}
        >
          <RefreshCw className='mr-1.5 h-3.5 w-3.5' />
          {t('Refresh QR code')}
        </Button>
      )}
      <p className='text-muted-foreground text-center text-xs'>
        {t('Open WeChat and scan the QR code to bind your account.')}
      </p>
    </div>
  )

  const renderCodeBody = () => (
    <div className='space-y-3 py-2'>
      {staticQrCode ? (
        <div className='border-border bg-muted/30 flex items-center justify-center overflow-hidden rounded-lg border p-2'>
          <img
            src={staticQrCode}
            alt={t('WeChat QR code')}
            className='h-44 w-44 object-contain'
          />
        </div>
      ) : (
        <div className='text-muted-foreground rounded-lg border border-dashed p-4 text-xs'>
          {t(
            'Follow the official account and reply with the keyword to receive a verification code.'
          )}
        </div>
      )}
      <div className='space-y-1.5'>
        <Label htmlFor='wechat-bind-code'>{t('Verification Code')}</Label>
        <Input
          id='wechat-bind-code'
          inputMode='numeric'
          value={verificationCode}
          maxLength={10}
          onChange={(event) => setVerificationCode(event.target.value)}
          placeholder={t('Enter the code from the WeChat reply')}
          disabled={submittingCode}
        />
      </div>
      <Button
        type='button'
        className='w-full'
        onClick={handleSubmitCode}
        disabled={submittingCode || !verificationCode.trim()}
      >
        {submittingCode && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
        {t('Bind WeChat')}
      </Button>
    </div>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('Bind WeChat Account')}
      description={
        showTabs
          ? t('Pick how you would like to bind your WeChat.')
          : onlyScan
            ? t('Scan the QR code with WeChat to bind your account')
            : onlyCode
              ? t('Bind WeChat with a verification code')
              : t('WeChat binding is currently disabled.')
      }
      contentClassName='sm:max-w-md'
      contentHeight='auto'
      bodyClassName='space-y-4'
    >
      {showTabs ? (
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as TabKey)}
          className='w-full'
        >
          <TabsList className='grid w-full grid-cols-2'>
            <TabsTrigger value='scan'>{t('Scan to bind')}</TabsTrigger>
            <TabsTrigger value='code'>{t('Code to bind')}</TabsTrigger>
          </TabsList>
          <TabsContent value='scan'>{renderScanBody()}</TabsContent>
          <TabsContent value='code'>{renderCodeBody()}</TabsContent>
        </Tabs>
      ) : onlyScan ? (
        renderScanBody()
      ) : onlyCode ? (
        renderCodeBody()
      ) : (
        <div className='text-muted-foreground py-4 text-center text-sm'>
          {t('WeChat binding is currently disabled.')}
        </div>
      )}
    </Dialog>
  )
}
