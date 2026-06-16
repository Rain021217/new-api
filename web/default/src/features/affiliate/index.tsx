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
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Download, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSystemConfigStore } from '@/stores/system-config-store'
import { formatNumber, formatTimestampToDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from '@/components/ui/chart'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { SectionPageLayout } from '@/components/layout'
import { StatusBadge, type StatusBadgeProps } from '@/components/status-badge'
import {
  getAffiliateLogs,
  getAffiliateStatus,
  getAffiliateSummary,
  getAffiliateTeamTree,
} from './api'
import {
  buildAffiliateLogsExportQuery,
  buildAffiliateLogsParams,
  formatAffiliateRmbFromQuota,
  formatRawQuota,
  getAffiliateUnavailableMessage,
} from './lib'
import { buildAffiliateTrendRows } from './trend-lib'
import type {
  AffiliateLog,
  AffiliateLogFilters,
  AffiliateSummary as AffiliateSummaryData,
  AffiliateTeamTreeNode,
} from './types'

const DEFAULT_PAGE_SIZE = 20

const EMPTY_FILTERS: AffiliateLogFilters = {
  model: '',
  group: '',
  userId: '',
  secondLevelUserId: '',
  requestStatus: '',
  startTime: '',
  endTime: '',
}

const LOG_STATUS_META: Record<
  number,
  { labelKey: string; variant: StatusBadgeProps['variant'] }
> = {
  2: { labelKey: 'Success', variant: 'success' },
  5: { labelKey: 'Failed', variant: 'danger' },
  6: { labelKey: 'Refund', variant: 'warning' },
}

function formatRmb(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return '-'
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

function getScopeLabel(
  scopeKind: string | undefined,
  t: (key: string) => string
) {
  switch (scopeKind) {
    case 'global':
      return t('Global affiliate scope')
    case 'affiliate':
      return t('Affiliate scope')
    default:
      return t('No affiliate scope')
  }
}

function getRuleStatusLabel(
  status: string | undefined,
  t: (key: string) => string
) {
  switch (status) {
    case 'pending_rules':
      return t('Rules pending')
    case 'published_rules':
      return t('Rules published')
    case 'no_rules':
      return t('No published rules')
    default:
      return status || t('N/A')
  }
}

function getSourceLabel(
  source: string | undefined,
  t: (key: string) => string
) {
  switch (source) {
    case 'affiliate':
      return t('Affiliate invite')
    case 'wechat':
      return t('WeChat')
    case 'legacy_inviter':
      return t('Legacy inviter')
    case 'manual':
      return t('Manual')
    case 'password':
      return t('Password registration')
    case 'oauth':
      return t('OAuth')
    case 'sms':
      return t('SMS registration')
    default:
      return source || '-'
  }
}

function getLogTypeMeta(type: number, t: (key: string) => string) {
  const meta = LOG_STATUS_META[type]
  if (!meta) {
    return { label: t('Unknown'), variant: 'neutral' as const }
  }
  return { label: t(meta.labelKey), variant: meta.variant }
}

type SummaryMetricAccent =
  | 'chart-1'
  | 'chart-2'
  | 'chart-3'
  | 'chart-4'
  | 'chart-5'
  | 'primary'

const ACCENT_BORDER_CLASS: Record<SummaryMetricAccent, string> = {
  'chart-1': 'before:bg-chart-1',
  'chart-2': 'before:bg-chart-2',
  'chart-3': 'before:bg-chart-3',
  'chart-4': 'before:bg-chart-4',
  'chart-5': 'before:bg-chart-5',
  primary: 'before:bg-primary',
}

function SummaryMetric(props: {
  title: string
  value: string
  description?: string
  muted?: boolean
  accent?: SummaryMetricAccent
  numeric?: boolean
}) {
  return (
    <Card
      size='sm'
      className={cn(
        'relative isolate overflow-hidden before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r-full',
        props.accent
          ? ACCENT_BORDER_CLASS[props.accent]
          : 'before:bg-transparent',
        props.muted && 'border-dashed before:opacity-40'
      )}
    >
      <CardHeader>
        <CardDescription className='text-[11px] font-medium tracking-wide uppercase'>
          {props.title}
        </CardDescription>
        <CardTitle
          className={cn(
            'text-xl leading-tight',
            props.numeric && 'font-mono tabular-nums'
          )}
        >
          {props.value}
        </CardTitle>
      </CardHeader>
      {props.description && (
        <CardContent>
          <p className='text-muted-foreground text-xs leading-snug'>
            {props.description}
          </p>
        </CardContent>
      )}
    </Card>
  )
}

function SummaryCards(props: {
  summary: AffiliateSummaryData | undefined
  isLoading: boolean
}) {
  const { t } = useTranslation()
  const summary = props.summary
  const rulePending = summary?.rule_status === 'pending_rules'

  return (
    <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
      <SummaryMetric
        title={t('Team Users')}
        value={props.isLoading ? '-' : formatNumber(summary?.team_user_count)}
        accent='primary'
        numeric
      />
      <SummaryMetric
        title={t('Effective New Users')}
        value={
          props.isLoading
            ? '-'
            : formatNumber(summary?.effective_new_user_count)
        }
        accent='chart-2'
        numeric
      />
      <SummaryMetric
        title={t('Net Paid Usage')}
        value={
          props.isLoading ? '-' : formatRmb(summary?.net_consumption_rmb, 4)
        }
        description={
          summary
            ? `${t('Raw quota')}: ${formatRawQuota(summary.net_consumption_quota)}`
            : undefined
        }
        accent='chart-3'
        numeric
      />
      <SummaryMetric
        title={t('Estimated Commission')}
        value={
          props.isLoading ? '-' : formatRmb(summary?.estimated_commission_rmb)
        }
        muted={rulePending}
        accent='chart-1'
        numeric
      />
      <SummaryMetric
        title={t('Head Fee')}
        value={props.isLoading ? '-' : formatRmb(summary?.head_fee_rmb)}
        muted={rulePending}
        accent='chart-4'
        numeric
      />
      <SummaryMetric
        title={t('Pending Settlement')}
        value={
          props.isLoading ? '-' : formatRmb(summary?.pending_settlement_rmb)
        }
        muted={rulePending}
        accent='chart-5'
        numeric
      />
      <SummaryMetric
        title={t('KPI Tier')}
        value={props.isLoading ? '-' : summary?.kpi_tier_name || t('N/A')}
        description={
          rulePending
            ? t('Commission, KPI and head fee rules are pending configuration')
            : getRuleStatusLabel(summary?.rule_status, t)
        }
        muted={rulePending}
        accent='primary'
      />
    </div>
  )
}

function AffiliateTrendTooltip(props: {
  active?: boolean
  payload?: Array<{ payload: Record<string, number | string> }>
  t: (key: string) => string
}) {
  const { active, payload, t } = props
  if (!active || !payload || payload.length === 0) return null
  const datum = payload[0].payload
  const rmb = (value: unknown) => `¥${(Number(value) || 0).toFixed(2)}`
  const lines: Array<[string, string]> = [
    [t('Net Paid Usage'), rmb(datum.netConsumption)],
    [t('Estimated Commission'), rmb(datum.commission)],
    [t('Head Fee'), rmb(datum.headFee)],
    [t('Pending Settlement'), rmb(datum.pending)],
    [t('Effective New Users'), String(Number(datum.effectiveUsers) || 0)],
  ]
  return (
    <div className='border-border/50 bg-background grid min-w-44 gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl'>
      <div className='font-medium'>{String(datum.date ?? '')}</div>
      {lines.map(([label, value]) => (
        <div key={label} className='flex items-center justify-between gap-3'>
          <span className='text-muted-foreground'>{label}</span>
          <span className='font-mono font-medium tabular-nums'>{value}</span>
        </div>
      ))}
    </div>
  )
}

type AffiliateTrendSeriesKey =
  | 'commission'
  | 'netConsumption'
  | 'pending'
  | 'headFee'

interface AffiliateTrendSeriesMeta {
  key: AffiliateTrendSeriesKey
  labelKey: string
  color: string
  yFormat: 'currency' | 'count'
}

const AFFILIATE_TREND_SERIES: AffiliateTrendSeriesMeta[] = [
  {
    key: 'commission',
    labelKey: 'Estimated Commission',
    color: 'var(--chart-1)',
    yFormat: 'currency',
  },
  {
    key: 'netConsumption',
    labelKey: 'Net Paid Usage',
    color: 'var(--chart-3)',
    yFormat: 'currency',
  },
  {
    key: 'pending',
    labelKey: 'Pending Settlement',
    color: 'var(--chart-5)',
    yFormat: 'currency',
  },
  {
    key: 'headFee',
    labelKey: 'Head Fee',
    color: 'var(--chart-4)',
    yFormat: 'currency',
  },
]

function AffiliateTrendPanel(props: {
  summary: AffiliateSummaryData | undefined
  isLoading: boolean
}) {
  const { t } = useTranslation()
  const [activeSeries, setActiveSeries] =
    useState<AffiliateTrendSeriesKey>('commission')
  const rows = useMemo(
    () => buildAffiliateTrendRows(props.summary),
    [props.summary]
  )
  const chartData = useMemo(
    () =>
      rows.map((row) => ({
        date: row.label,
        netConsumption: Number(row.netConsumptionRmb.toFixed(2)),
        commission: Number(row.estimatedCommissionRmb.toFixed(2)),
        headFee: Number(row.headFeeRmb.toFixed(2)),
        pending: Number(row.pendingSettlementRmb.toFixed(2)),
        effectiveUsers: row.effectiveNewUsers,
      })),
    [rows]
  )
  const activeMeta = useMemo(
    () =>
      AFFILIATE_TREND_SERIES.find((item) => item.key === activeSeries) ??
      AFFILIATE_TREND_SERIES[0],
    [activeSeries]
  )
  const chartConfig = useMemo<ChartConfig>(
    () => ({
      [activeMeta.key]: { label: t(activeMeta.labelKey), color: activeMeta.color },
    }),
    [activeMeta, t]
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('14-Day Affiliate Trend')}</CardTitle>
        <CardDescription>
          {t('Paid usage, effective users, commission and pending settlement')}
        </CardDescription>
        <CardAction>
          <div className='bg-muted/40 inline-flex items-center gap-0.5 rounded-lg p-0.5'>
            {AFFILIATE_TREND_SERIES.map((item) => {
              const isActive = item.key === activeSeries
              return (
                <button
                  key={item.key}
                  type='button'
                  onClick={() => setActiveSeries(item.key)}
                  aria-pressed={isActive}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    isActive
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t(item.labelKey)}
                </button>
              )
            })}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        {props.isLoading ? (
          <div
            className='bg-muted/40 h-[280px] w-full animate-pulse rounded-lg'
            aria-hidden='true'
          />
        ) : chartData.length === 0 ? (
          <div className='border-border/60 flex h-[280px] w-full flex-col items-center justify-center rounded-lg border border-dashed px-6 text-center'>
            <div className='text-sm font-medium'>
              {t('No trend data yet')}
            </div>
            <div className='text-muted-foreground mt-1 max-w-md text-xs leading-relaxed'>
              {t(
                'Trend updates after paid usage, effective users or settlements are recorded'
              )}
            </div>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className='h-[280px] w-full'>
            <BarChart
              accessibilityLayer
              data={chartData}
              margin={{ left: 4, right: 8, top: 8 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey='date'
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={8}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(value) =>
                  activeMeta.yFormat === 'currency'
                    ? `¥${Number(value).toLocaleString()}`
                    : Number(value).toLocaleString()
                }
              />
              <ChartTooltip
                cursor={false}
                content={<AffiliateTrendTooltip t={t} />}
              />
              <Bar
                dataKey={activeMeta.key}
                fill={`var(--color-${activeMeta.key})`}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

function TeamTreeNode(props: { node: AffiliateTeamTreeNode; depth?: number }) {
  const { t } = useTranslation()
  const children = props.node.children ?? []
  const hasChildren = children.length > 0
  const depth = props.depth ?? 0
  const [expanded, setExpanded] = useState(depth < 2)
  const displayName = props.node.username || `#${props.node.user_id}`

  return (
    <div className='border-border/60 ml-3 border-l pl-2'>
      <div className='hover:bg-muted/40 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-1 py-0.5 text-sm transition-colors'>
        {hasChildren ? (
          <button
            type='button'
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? t('Collapse') : t('Expand')}
            className='text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 -ml-1 flex size-6 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none'
          >
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform duration-150',
                expanded && 'rotate-90'
              )}
            />
          </button>
        ) : (
          <span className='inline-block size-6 shrink-0' />
        )}
        <span className='font-medium'>{displayName}</span>
        <span className='text-muted-foreground/80 font-mono text-xs tabular-nums'>
          ID {props.node.user_id}
        </span>
        {props.node.affiliate_level ? (
          <span className='bg-primary/10 text-primary inline-flex h-4 items-center rounded-sm px-1 text-[10px] leading-none font-semibold tracking-wide tabular-nums'>
            L{props.node.affiliate_level}
          </span>
        ) : null}
        <span className='text-muted-foreground/80 text-xs'>
          · {t('Depth')} {props.node.depth ?? '-'}
        </span>
        {props.node.source ? (
          <span className='text-muted-foreground/80 text-xs'>
            · {getSourceLabel(props.node.source, t)}
          </span>
        ) : null}
        {hasChildren ? (
          <span className='text-muted-foreground/60 tabular-nums text-xs'>
            · {children.length}
          </span>
        ) : null}
      </div>
      {hasChildren && expanded ? (
        <div>
          {children.map((child) => (
            <TeamTreeNode key={child.user_id} node={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function AffiliateTeamTreePanel(props: {
  nodes: AffiliateTeamTreeNode[]
  total: number
  isLoading: boolean
}) {
  const { t } = useTranslation()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Promotion Relationship Tree')}</CardTitle>
        <CardDescription>
          {t(
            'Level-one affiliates can see level-two affiliates and their downstream users'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {props.isLoading ? (
          <div className='space-y-2'>
            <div className='bg-muted/40 h-4 w-24 animate-pulse rounded' />
            <div className='bg-muted/40 h-6 w-full animate-pulse rounded' />
            <div className='bg-muted/40 ml-4 h-6 w-3/4 animate-pulse rounded' />
            <div className='bg-muted/40 ml-4 h-6 w-2/3 animate-pulse rounded' />
          </div>
        ) : props.nodes.length === 0 ? (
          <div className='border-border/60 text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm'>
            {t('No downstream users')}
          </div>
        ) : (
          <div className='space-y-2'>
            <div className='text-muted-foreground text-xs'>
              {t('Total')}:{' '}
              <span className='text-foreground font-medium tabular-nums'>
                {props.total}
              </span>
            </div>
            {props.nodes.map((node) => (
              <TeamTreeNode key={node.user_id} node={node} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AffiliateLogFiltersForm(props: {
  draftFilters: AffiliateLogFilters
  setDraftFilters: (filters: AffiliateLogFilters) => void
  onApply: () => void
  onReset: () => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const update = (key: keyof AffiliateLogFilters, value: string) => {
    props.setDraftFilters({ ...props.draftFilters, [key]: value })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Affiliate Log Filters')}</CardTitle>
        <CardDescription>
          {t('Filters are limited to affiliate scoped fields')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          <Input
            placeholder={t('Model')}
            value={props.draftFilters.model}
            disabled={props.disabled}
            onChange={(event) => update('model', event.target.value)}
          />
          <Input
            placeholder={t('Group')}
            value={props.draftFilters.group}
            disabled={props.disabled}
            onChange={(event) => update('group', event.target.value)}
          />
          <Input
            placeholder={t('User ID')}
            value={props.draftFilters.userId}
            disabled={props.disabled}
            inputMode='numeric'
            onChange={(event) => update('userId', event.target.value)}
          />
          <Input
            placeholder={t('Second-level Affiliate ID')}
            value={props.draftFilters.secondLevelUserId}
            disabled={props.disabled}
            inputMode='numeric'
            onChange={(event) =>
              update('secondLevelUserId', event.target.value)
            }
          />
          <select
            className='border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm transition-colors outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50'
            value={props.draftFilters.requestStatus}
            disabled={props.disabled}
            onChange={(event) => update('requestStatus', event.target.value)}
          >
            <option value=''>{t('All Request Statuses')}</option>
            <option value='success'>{t('Success')}</option>
            <option value='error'>{t('Failed')}</option>
            <option value='refund'>{t('Refund')}</option>
          </select>
          <Input
            type='datetime-local'
            value={props.draftFilters.startTime}
            disabled={props.disabled}
            onChange={(event) => update('startTime', event.target.value)}
          />
          <Input
            type='datetime-local'
            value={props.draftFilters.endTime}
            disabled={props.disabled}
            onChange={(event) => update('endTime', event.target.value)}
          />
          <div className='flex gap-2'>
            <Button
              className='flex-1'
              disabled={props.disabled}
              onClick={props.onApply}
            >
              {t('Apply')}
            </Button>
            <Button
              className='flex-1'
              variant='outline'
              disabled={props.disabled}
              onClick={props.onReset}
            >
              {t('Reset')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function AffiliateLogsTable(props: {
  logs: AffiliateLog[]
  total: number
  page: number
  pageSize: number
  exportUrl: string
  isLoading: boolean
  onPageChange: (page: number) => void
}) {
  const { t } = useTranslation()
  const currencyConfig = useSystemConfigStore((state) => state.config.currency)
  const hasNext = props.page * props.pageSize < props.total
  const handleExport = () => {
    if (props.logs.length === 0) return
    const anchor = document.createElement('a')
    anchor.href = props.exportUrl
    anchor.download = 'affiliate-logs.csv'
    anchor.click()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('Affiliate Scoped Logs')}</CardTitle>
        <CardDescription>
          {t('Showing only users visible to the current affiliate scope')}
        </CardDescription>
        <CardAction>
          <Button
            variant='outline'
            size='sm'
            disabled={props.isLoading || props.logs.length === 0}
            onClick={handleExport}
          >
            <Download className='size-4' />
            {t('Download')} CSV
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className='space-y-3'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Time')}</TableHead>
              <TableHead>{t('User')}</TableHead>
              <TableHead>{t('Type')}</TableHead>
              <TableHead>{t('Model')}</TableHead>
              <TableHead>{t('Group')}</TableHead>
              <TableHead>{t('Request Status')}</TableHead>
              <TableHead className='text-right'>{t('Cost')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.isLoading ? (
              Array.from({ length: 4 }).map((_, index) => (
                <TableRow key={`affiliate-log-skeleton-${index}`}>
                  {Array.from({ length: 7 }).map((__, cellIndex) => (
                    <TableCell key={cellIndex}>
                      <div className='bg-muted/40 h-4 w-full animate-pulse rounded' />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : props.logs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className='text-muted-foreground h-24 text-center text-sm'
                >
                  {t('No affiliate logs')}
                </TableCell>
              </TableRow>
            ) : (
              props.logs.map((log) => {
                const status = getLogTypeMeta(log.type, t)
                return (
                  <TableRow key={`${log.id}-${log.created_at}-${log.user_id}`}>
                    <TableCell className='font-mono text-xs tabular-nums'>
                      {formatTimestampToDate(log.created_at)}
                    </TableCell>
                    <TableCell>
                      <div className='flex flex-col leading-tight'>
                        <span>{log.username || `#${log.user_id}`}</span>
                        <span className='text-muted-foreground font-mono text-xs tabular-nums'>
                          ID {log.user_id}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className='tabular-nums'>{log.type}</TableCell>
                    <TableCell>{log.model_name || '-'}</TableCell>
                    <TableCell>{log.group || '-'}</TableCell>
                    <TableCell>
                      <StatusBadge
                        label={status.label}
                        variant={status.variant}
                        copyable={false}
                      />
                    </TableCell>
                    <TableCell
                      className='text-right font-mono font-medium tabular-nums'
                      title={`${t('Raw quota')}: ${formatRawQuota(log.quota)}`}
                    >
                      {formatAffiliateRmbFromQuota(log.quota, currencyConfig)}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>

        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='text-muted-foreground text-sm'>
            {t('Total')}: {props.total}
          </div>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              disabled={props.page <= 1 || props.isLoading}
              onClick={() => props.onPageChange(Math.max(1, props.page - 1))}
            >
              {t('Previous')}
            </Button>
            <span className='text-muted-foreground text-sm'>
              {t('Page')} {props.page}
            </span>
            <Button
              variant='outline'
              disabled={!hasNext || props.isLoading}
              onClick={() => props.onPageChange(props.page + 1)}
            >
              {t('Next')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function Affiliate() {
  const { t } = useTranslation()
  const [filters, setFilters] = useState<AffiliateLogFilters>(EMPTY_FILTERS)
  const [draftFilters, setDraftFilters] =
    useState<AffiliateLogFilters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)

  const statusQuery = useQuery({
    queryKey: ['affiliate', 'status'],
    queryFn: getAffiliateStatus,
  })

  const status = statusQuery.data?.data
  const available = Boolean(status?.available)

  const summaryQuery = useQuery({
    queryKey: ['affiliate', 'summary'],
    queryFn: getAffiliateSummary,
    enabled: available,
  })

  const teamTreeQuery = useQuery({
    queryKey: ['affiliate', 'team-tree'],
    queryFn: getAffiliateTeamTree,
    enabled: available,
  })

  const logParams = useMemo(
    () => buildAffiliateLogsParams(filters, page, DEFAULT_PAGE_SIZE),
    [filters, page]
  )

  const logsQuery = useQuery({
    queryKey: ['affiliate', 'logs', logParams],
    queryFn: () => getAffiliateLogs(logParams),
    enabled: available,
  })

  const summary = summaryQuery.data?.data
  const teamTree = teamTreeQuery.data?.data
  const logsPage = logsQuery.data?.data
  const unavailableMessage = getAffiliateUnavailableMessage(
    status?.unavailable_reason,
    status?.message || statusQuery.data?.message,
    t
  )

  const applyFilters = () => {
    setFilters({ ...draftFilters })
    setPage(1)
  }

  const resetFilters = () => {
    setDraftFilters(EMPTY_FILTERS)
    setFilters(EMPTY_FILTERS)
    setPage(1)
  }

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Affiliate Center')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          disabled={statusQuery.isFetching}
          onClick={() => void statusQuery.refetch()}
        >
          <RefreshCw className='size-4' />
          {t('Refresh')}
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='space-y-4'>
          <Card>
            <CardHeader>
              <CardTitle>{t('Affiliate Scope')}</CardTitle>
              <CardDescription>
                {t('Affiliate access is enforced by backend scoped APIs')}
              </CardDescription>
            </CardHeader>
            <CardContent className='flex flex-wrap items-center gap-2'>
              <StatusBadge
                label={
                  statusQuery.isLoading
                    ? t('Loading')
                    : getScopeLabel(status?.scope?.kind, t)
                }
                variant={available ? 'success' : 'neutral'}
                copyable={false}
              />
              {status?.scope?.affiliate_level ? (
                <StatusBadge
                  label={`${t('Level')} ${status.scope.affiliate_level}`}
                  variant='info'
                  copyable={false}
                />
              ) : null}
            </CardContent>
          </Card>

          {!statusQuery.isLoading && !available ? (
            <Card size='sm' className='border-warning/40 bg-warning/5'>
              <CardHeader>
                <CardTitle>{t('Affiliate feature is unavailable')}</CardTitle>
                <CardDescription>{unavailableMessage}</CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          {available ? (
            <>
              <SummaryCards
                summary={summary}
                isLoading={summaryQuery.isLoading || summaryQuery.isFetching}
              />
              <AffiliateTrendPanel
                summary={summary}
                isLoading={summaryQuery.isLoading || summaryQuery.isFetching}
              />
              {summaryQuery.data && !summaryQuery.data.success ? (
                <Card className='border-warning/40'>
                  <CardHeader>
                    <CardTitle>{t('Failed to load affiliate data')}</CardTitle>
                    <CardDescription>
                      {t('Please refresh or contact an administrator')}
                    </CardDescription>
                  </CardHeader>
                </Card>
              ) : null}
              <AffiliateTeamTreePanel
                nodes={teamTree?.items ?? []}
                total={teamTree?.total ?? 0}
                isLoading={teamTreeQuery.isLoading || teamTreeQuery.isFetching}
              />
              {teamTreeQuery.data && !teamTreeQuery.data.success ? (
                <Card className='border-warning/40'>
                  <CardHeader>
                    <CardTitle>{t('Failed to load affiliate data')}</CardTitle>
                    <CardDescription>
                      {t('Please refresh or contact an administrator')}
                    </CardDescription>
                  </CardHeader>
                </Card>
              ) : null}
              <AffiliateLogFiltersForm
                draftFilters={draftFilters}
                setDraftFilters={setDraftFilters}
                disabled={logsQuery.isFetching}
                onApply={applyFilters}
                onReset={resetFilters}
              />
              <AffiliateLogsTable
                logs={logsPage?.items ?? []}
                total={logsPage?.total ?? 0}
                page={page}
                pageSize={DEFAULT_PAGE_SIZE}
                exportUrl={buildAffiliateLogsExportQuery(logParams)}
                isLoading={logsQuery.isLoading || logsQuery.isFetching}
                onPageChange={setPage}
              />
              {logsQuery.data && !logsQuery.data.success ? (
                <Card className='border-warning/40'>
                  <CardHeader>
                    <CardTitle>{t('Failed to load affiliate data')}</CardTitle>
                    <CardDescription>
                      {t('Please adjust filters or refresh the page')}
                    </CardDescription>
                  </CardHeader>
                </Card>
              ) : null}
            </>
          ) : null}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
