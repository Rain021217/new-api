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
import { Loader2, LogIn, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog } from '@/components/dialog'
import { useStatus } from '@/hooks/use-status'
import {
  createWechatLoginQrcode,
  getWechatLoginStatus,
  wechatLoginByCode,
} from '@/features/auth/api'
import type { SystemStatus } from '@/features/auth/types'

type WeChatLoginDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Affiliate code forwarded to the QR-code request (sign-up referral). */
  affCode?: string
  /**
   * Called once the poll returns a successful login result. Receives the
   * standard login `data` payload; reuse the parent's existing login-success
   * handler so the user is stored and redirected exactly like password login.
   */
  onLoginSuccess: (data: { id?: number } | null) => void | Promise<void>
  /** Called when the poll result indicates 2FA is required. */
  onRequire2FA: () => void
}

type ScanPhase = 'loading' | 'ready' | 'expired' | 'error'

type TabKey = 'scan' | 'code'

const DEFAULT_POLL_INTERVAL_SECONDS = 2

/**
 * Pick which WeChat login methods are enabled based on /api/status.
 * Falls back to the legacy `wechat_login` flag so this keeps working before
 * the new tunables ship.
 */
function resolveMethods(status: SystemStatus | null) {
  const legacy = Boolean(status?.wechat_login)
  const scan = Boolean(status?.wechat_scan_login_enabled ?? legacy)
  const code = Boolean(status?.wechat_code_login_enabled ?? legacy)
  const defaultMethod: TabKey =
    status?.wechat_login_default_method === 'code' ? 'code' : 'scan'
  return { scan, code, defaultMethod }
}

function readStaticQrCode(status: SystemStatus | null): string {
  // Backend exposes the legacy account QR under a few historic keys; prefer
  // the canonical one but fall through so older deployments still render it.
  return (
    (status?.wechat_qrcode as string | undefined) ||
    (status?.wechat_qr_code as string | undefined) ||
    (status?.wechat_qrcode_image_url as string | undefined) ||
    (status?.wechat_qr_code_image_url as string | undefined) ||
    (status?.wechat_account_qrcode_image_url as string | undefined) ||
    (status?.WeChatAccountQRCodeImageURL as string | undefined) ||
    ''
  )
}

export function WeChatLoginDialog({
  open,
  onOpenChange,
  affCode,
  onLoginSuccess,
  onRequire2FA,
}: WeChatLoginDialogProps) {
  const { t } = useTranslation()
  const { status } = useStatus()
  const { scan: scanEnabled, code: codeEnabled, defaultMethod } =
    resolveMethods(status)
  const staticQrCode = readStaticQrCode(status)

  // The list of tabs actually rendered (in display order). If only one method
  // is enabled the Tabs primitive is bypassed so the body looks like the
  // single-method version.
  const visibleTabs = useMemo<TabKey[]>(() => {
    const tabs: TabKey[] = []
    if (scanEnabled) tabs.push('scan')
    if (codeEnabled) tabs.push('code')
    return tabs
  }, [scanEnabled, codeEnabled])

  const initialTab: TabKey = useMemo(() => {
    if (visibleTabs.length === 0) return 'scan'
    if (visibleTabs.includes(defaultMethod)) return defaultMethod
    return visibleTabs[0]
  }, [defaultMethod, visibleTabs])

  const [activeTab, setActiveTab] = useState<TabKey>(initialTab)

  // Reset the active tab whenever the dialog (re)opens so the default flag
  // is honoured even after the user previously switched manually.
  useEffect(() => {
    if (open) {
      setActiveTab(initialTab)
    }
  }, [open, initialTab])

  // ----- Scan-login state (extracted from the legacy scan-only dialog) -----
  const [phase, setPhase] = useState<ScanPhase>('loading')
  const [qrImageUrl, setQrImageUrl] = useState('')
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')

  const loginTokenRef = useRef('')
  const pollTimerRef = useRef<number | null>(null)
  const countdownTimerRef = useRef<number | null>(null)
  const requestIdRef = useRef(0)
  const isFinishingRef = useRef(false)

  const clearTimers = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }, [])

  const stopAll = useCallback(() => {
    clearTimers()
    requestIdRef.current += 1
    loginTokenRef.current = ''
  }, [clearTimers])

  const pollOnce = useCallback(
    async (requestId: number) => {
      const loginToken = loginTokenRef.current
      if (!loginToken || isFinishingRef.current) return
      if (requestId !== requestIdRef.current) return

      let res
      try {
        res = await getWechatLoginStatus(loginToken)
      } catch (_error) {
        // Transient error — keep polling.
        return
      }

      if (requestId !== requestIdRef.current || isFinishingRef.current) return
      if (!res?.success) return

      const pollStatus = res.data?.status
      if (pollStatus === 'pending') return
      if (pollStatus === 'expired') {
        clearTimers()
        setSecondsLeft(0)
        setPhase('expired')
        return
      }

      isFinishingRef.current = true
      clearTimers()

      if (res.data?.require_2fa) {
        onRequire2FA()
        return
      }

      try {
        await onLoginSuccess((res.data as { id?: number }) ?? null)
        toast.success(t('Signed in via WeChat'))
        onOpenChange(false)
      } catch (_error) {
        isFinishingRef.current = false
        toast.error(t('Login failed'))
      }
    },
    [clearTimers, onLoginSuccess, onOpenChange, onRequire2FA, t]
  )

  const fetchQrCode = useCallback(async () => {
    clearTimers()
    const requestId = (requestIdRef.current += 1)
    isFinishingRef.current = false
    loginTokenRef.current = ''
    setPhase('loading')
    setQrImageUrl('')
    setErrorMessage('')
    setSecondsLeft(0)

    try {
      const res = await createWechatLoginQrcode(affCode)
      if (requestId !== requestIdRef.current) return

      if (!res?.success || !res.data?.login_token || !res.data.qrcode_image_url) {
        setErrorMessage(res?.message || t('Failed to load QR code'))
        setPhase('error')
        return
      }

      const { login_token, qrcode_image_url, expire_seconds } = res.data
      const pollInterval =
        res.data.poll_interval_seconds &&
        res.data.poll_interval_seconds > 0
          ? res.data.poll_interval_seconds
          : DEFAULT_POLL_INTERVAL_SECONDS

      loginTokenRef.current = login_token
      setQrImageUrl(qrcode_image_url)
      setPhase('ready')

      const total = expire_seconds && expire_seconds > 0 ? expire_seconds : 0
      setSecondsLeft(total)
      if (total > 0) {
        countdownTimerRef.current = window.setInterval(() => {
          setSecondsLeft((prev) => {
            if (prev <= 1) {
              if (countdownTimerRef.current !== null) {
                window.clearInterval(countdownTimerRef.current)
                countdownTimerRef.current = null
              }
              if (pollTimerRef.current !== null) {
                window.clearInterval(pollTimerRef.current)
                pollTimerRef.current = null
              }
              setPhase('expired')
              return 0
            }
            return prev - 1
          })
        }, 1000)
      }

      pollTimerRef.current = window.setInterval(() => {
        void pollOnce(requestId)
      }, pollInterval * 1000)
    } catch (_error) {
      if (requestId !== requestIdRef.current) return
      setErrorMessage(t('Failed to load QR code'))
      setPhase('error')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pollOnce only reads refs; excluding it keeps fetchQrCode stable so the QR isn't refetched on every parent re-render
  }, [affCode, clearTimers, t])

  // Drive the scan-login lifecycle: start when the scan tab is actually
  // visible (dialog open + tab active + method enabled), tear everything
  // down otherwise so we don't poll for a hidden tab.
  useEffect(() => {
    const scanTabActive = open && activeTab === 'scan' && scanEnabled
    if (scanTabActive) {
      void fetchQrCode()
    } else {
      stopAll()
      isFinishingRef.current = false
    }
    return () => {
      stopAll()
    }
  }, [open, activeTab, scanEnabled, fetchQrCode, stopAll])

  // ----- Code-login state (legacy public-account verification code) -----
  const [code, setCode] = useState('')
  const [isCodeSubmitting, setIsCodeSubmitting] = useState(false)

  // Reset the code input whenever the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setCode('')
      setIsCodeSubmitting(false)
    }
  }, [open])

  const handleSubmitCode = useCallback(async () => {
    const trimmed = code.trim()
    if (!trimmed) {
      toast.error(t('Please enter the verification code'))
      return
    }

    setIsCodeSubmitting(true)
    try {
      const res = await wechatLoginByCode(trimmed)
      if (res?.success) {
        const data = (res.data as { require_2fa?: boolean; id?: number }) ?? null
        if (data?.require_2fa) {
          onRequire2FA()
          return
        }
        await onLoginSuccess(data)
        toast.success(t('Signed in via WeChat'))
        onOpenChange(false)
      } else {
        toast.error(res?.message || t('Login failed'))
      }
    } catch (_error) {
      toast.error(t('Login failed'))
    } finally {
      setIsCodeSubmitting(false)
    }
  }, [code, onLoginSuccess, onOpenChange, onRequire2FA, t])

  const showCountdown = phase === 'ready' && secondsLeft > 0
  const showTabs = visibleTabs.length >= 2

  // ----- Render helpers (per tab) -----
  const scanBody = (
    <div className='flex flex-col items-center gap-3'>
      <div className='bg-muted/30 relative flex h-48 w-48 items-center justify-center overflow-hidden rounded-md border'>
        {phase === 'ready' && qrImageUrl ? (
          <img
            src={qrImageUrl}
            alt={t('WeChat login QR code')}
            className='h-full w-full object-contain'
          />
        ) : phase === 'loading' ? (
          <Loader2 className='text-muted-foreground h-8 w-8 animate-spin' />
        ) : (
          <div className='flex flex-col items-center gap-2 px-3 text-center'>
            <p className='text-muted-foreground text-sm'>
              {phase === 'error'
                ? errorMessage || t('Failed to load QR code')
                : t('QR code expired')}
            </p>
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='gap-2'
              onClick={() => void fetchQrCode()}
            >
              <RefreshCw className='h-4 w-4' />
              {t('Refresh QR code')}
            </Button>
          </div>
        )}
      </div>

      {showCountdown ? (
        <p className='text-muted-foreground text-xs'>
          {t('QR code expires in {{seconds}}s', { seconds: secondsLeft })}
        </p>
      ) : phase === 'ready' ? (
        <p className='text-muted-foreground text-xs'>
          {t('Waiting for scan…')}
        </p>
      ) : null}
    </div>
  )

  const codeBody = (
    <div className='flex flex-col items-center gap-3'>
      <div className='bg-muted/30 relative flex h-48 w-48 items-center justify-center overflow-hidden rounded-md border'>
        {staticQrCode ? (
          <img
            src={staticQrCode}
            alt={t('WeChat login QR code')}
            className='h-full w-full object-contain'
          />
        ) : (
          <p className='text-muted-foreground px-3 text-center text-xs'>
            {t('WeChat QR code will be displayed here')}
          </p>
        )}
      </div>
      <p className='text-muted-foreground text-center text-xs'>
        {t(
          'Scan the QR code to follow the official account and reply with “验证码” to receive your verification code.'
        )}
      </p>
      <div className='w-full space-y-2'>
        <Label htmlFor='wechat-verification-code'>
          {t('Verification code')}
        </Label>
        <Input
          id='wechat-verification-code'
          value={code}
          placeholder={t('Enter the verification code')}
          autoComplete='one-time-code'
          inputMode='numeric'
          onChange={(event) => setCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (!isCodeSubmitting) void handleSubmitCode()
            }
          }}
        />
      </div>
      <Button
        type='button'
        className='w-full justify-center gap-2'
        disabled={isCodeSubmitting || !code.trim()}
        onClick={() => void handleSubmitCode()}
      >
        {isCodeSubmitting ? (
          <Loader2 className='h-4 w-4 animate-spin' />
        ) : (
          <LogIn className='h-4 w-4' />
        )}
        {t('Sign in')}
      </Button>
    </div>
  )

  // If neither method is enabled the dialog still renders an empty body so
  // the parent can close it cleanly; the trigger button should already be
  // hidden by the parent's `hasWeChatLogin` guard.
  const body = (() => {
    if (visibleTabs.length === 0) return null
    if (!showTabs) {
      // Single-method: render the matching body directly (no tab strip).
      return visibleTabs[0] === 'scan' ? scanBody : codeBody
    }
    return (
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as TabKey)}
        className='gap-4'
      >
        <TabsList className='grid w-full grid-cols-2'>
          <TabsTrigger value='scan'>{t('Scan to sign in')}</TabsTrigger>
          <TabsTrigger value='code'>{t('Code to sign in')}</TabsTrigger>
        </TabsList>
        <TabsContent value='scan' className='pt-0'>
          {scanBody}
        </TabsContent>
        <TabsContent value='code' className='pt-0'>
          {codeBody}
        </TabsContent>
      </Tabs>
    )
  })()

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('WeChat sign in')}
      description={t('Open WeChat and scan the QR code to sign in.')}
      contentClassName='max-w-sm'
      headerClassName='text-left'
      contentHeight='auto'
      bodyClassName='space-y-4'
      footer={
        <Button
          type='button'
          variant='outline'
          onClick={() => onOpenChange(false)}
        >
          {t('Cancel')}
        </Button>
      }
    >
      {body}
    </Dialog>
  )
}
