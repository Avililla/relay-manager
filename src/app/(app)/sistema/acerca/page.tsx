import type { Metadata } from "next"
import { formatUptime } from "@/components/admin/system-model"
import { CopyButton } from "@/components/common/copy-button"
import { MiddleTruncate } from "@/components/common/middle-truncate"
import { BrandMark } from "@/components/shell/brand-mark"
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/panel"
import { system as t } from "@/lib/i18n/admin"
import { PRODUCT_NAME } from "@/lib/i18n/common"
import { formatBytes, formatDateTime } from "@/lib/i18n/format"
import { getPublicSettings } from "@/server/queries/settings"
import { getSystemInfo } from "@/server/queries/system"
import { adminPage } from "../_lib/guard"

export const metadata: Metadata = { title: `${t.tabs.acerca} · ${t.title}` }

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-body text-foreground">{children}</dd>
    </div>
  )
}

function PathRow({ label, value }: { label: string; value: string }) {
  return (
    <Row label={label}>
      <MiddleTruncate value={value} tail={28} copy copyLabel={t.copyValue(label)} className="text-foreground" />
    </Row>
  )
}

/** Sistema > Acerca de (§8.9), from getSystemInfo(): version, build, runtime, addresses, data paths, licence, credits. */
export default async function SistemaAcercaPage() {
  await adminPage()
  const [info, pub] = await Promise.all([getSystemInfo(), getPublicSettings()])
  const mono = "font-mono text-data tabular-nums"
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-5">
        <Panel>
          <PanelBody className="flex-row items-center gap-4">
            <BrandMark className="size-11" />
            <div className="flex min-w-0 flex-col">
              <p className="text-section text-foreground">{pub.labName}</p>
              <p className="text-meta text-muted-foreground">
                {PRODUCT_NAME} <span className={mono}>{info.version}</span> · <span className={mono}>{info.rev}</span>
              </p>
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.aboutSection}</PanelTitle></PanelHeader>
          <PanelBody className="py-2">
            <dl className="flex flex-col divide-y">
              <Row label={t.aboutVersion}><span className={mono}>{info.version}</span></Row>
              <Row label={t.aboutRev}><span className={mono}>{info.rev}</span></Row>
              <Row label={t.aboutBuildId}><span className={mono}>{info.buildId}</span></Row>
              <Row label={t.aboutBuilt}>{info.builtAt ? <span className="tabular-nums">{formatDateTime(info.builtAt)}</span> : <span className="text-muted-foreground">{t.aboutBuiltDev}</span>}</Row>
              <Row label={t.aboutMode}>{t.modes[info.mode]}</Row>
              <Row label={t.aboutNode}><span className={mono}>{info.node}</span></Row>
              <Row label={t.aboutPlatform}><span className={mono}>{info.platform}</span></Row>
              <Row label={t.aboutListen}><span className={mono}>{info.host}:{info.port}</span></Row>
              <Row label={t.aboutTls}>{info.tls ? t.aboutTlsOn : t.aboutTlsOff}</Row>
              <Row label={t.aboutUptime}>
                <span className="tabular-nums">{t.aboutUptimeSince(formatUptime(info.uptimeSec), formatDateTime(info.startedAt))}</span>
              </Row>
            </dl>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.aboutPaths}</PanelTitle></PanelHeader>
          <PanelBody className="py-2">
            <dl className="flex flex-col divide-y">
              <PathRow label={t.aboutDataDir} value={info.dataDir} />
              <PathRow label={t.aboutDb} value={info.dbFile} />
              <Row label={t.aboutDbSize}><span className={mono}>{formatBytes(info.dbSizeBytes)}</span></Row>
              <PathRow label={t.aboutCaptureDir} value={info.captureDir} />
              <Row label={t.aboutCaptureSize}><span className={mono}>{formatBytes(info.captureSizeBytes)}</span></Row>
              <PathRow label={t.aboutBackupDir} value={info.backupDir} />
              {info.configFile ? <PathRow label={t.aboutConfigFile} value={info.configFile} />
                : <Row label={t.aboutConfigFile}><span className="text-muted-foreground">{t.aboutNoConfigFile}</span></Row>}
            </dl>
          </PanelBody>
        </Panel>
      </div>

      <div className="flex min-w-0 flex-col gap-5 xl:sticky xl:top-5">
        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.aboutUrls}</PanelTitle></PanelHeader>
          <PanelBody className="gap-3">
            <PanelDescription>{t.aboutUrlsHelp}</PanelDescription>
            {info.urls.length ? (
              <ul className="flex flex-col gap-1.5">
                {info.urls.map((u) => (
                  <li key={u} className="flex min-w-0 items-center gap-1 rounded-md border bg-muted py-0.5 pr-0.5 pl-2.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-data text-foreground">{u}</span>
                    <CopyButton value={u} label={t.copyValue(u)} />
                  </li>
                ))}
              </ul>
            ) : <p className="text-body text-muted-foreground">{t.aboutNoUrls}</p>}
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.aboutLicense}</PanelTitle></PanelHeader>
          <PanelBody className="gap-1">
            <p className="text-body text-foreground">{t.aboutLicenseBody}</p>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader><PanelTitle as="h2">{t.aboutCredits}</PanelTitle></PanelHeader>
          <PanelBody className="gap-1">
            <p className="text-body font-medium text-foreground">{t.aboutAuthor}</p>
            <p className="text-body text-muted-foreground">{t.aboutTeam}</p>
          </PanelBody>
        </Panel>
      </div>
    </div>
  )
}
