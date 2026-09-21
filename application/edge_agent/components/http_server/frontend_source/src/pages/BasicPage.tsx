import { createEffect, createSignal, For, Show, type Component } from 'solid-js';
import { currentLocale, t, tf } from '../i18n';
import { scanWifi, type AppConfig, type WifiScanItem } from '../api/client';
import { createConfigTab } from '../state/configTab';
import { appStatus } from '../state/config';
import { TabShell } from '../components/layout/TabShell';
import { PageHeader } from '../components/ui/PageHeader';
import { CollapsibleConfigBlock, StaticConfigBlock } from '../components/ui/ConfigBlocks';
import { TextInput, SelectInput } from '../components/ui/FormField';
import { SavePanel } from '../components/ui/SavePanel';
import { Banner } from '../components/ui/Banner';
import { RestartConfirmModal } from '../components/system/RestartConfirmModal';
import { pushToast } from '../state/toast';
import { Button } from '../components/ui/Button';

type BasicForm = {
  wifi_ssid: string;
  wifi_password: string;
  ap_ssid: string;
  ap_password: string;
  ap_behavior: string;
  time_timezone: string;
};

export const BasicPage: Component<{ onRestartRequest: () => void }> = (props) => {
  const tab = createConfigTab<BasicForm>({
    tab: 'basic',
    groups: ['wifi', 'time'],
    toForm: (config: Partial<AppConfig>) => ({
      wifi_ssid: config.wifi_ssid ?? '',
      wifi_password: config.wifi_password ?? '',
      ap_ssid: config.ap_ssid ?? '',
      ap_password: config.ap_password ?? '',
      ap_behavior: config.ap_behavior ?? 'keep',
      time_timezone: config.time_timezone ?? '',
    }),
    fromForm: (form) => ({
      wifi_ssid: form.wifi_ssid.trim(),
      wifi_password: form.wifi_password,
      ap_ssid: form.ap_ssid.trim(),
      ap_password: form.ap_password,
      ap_behavior: form.ap_behavior,
      time_timezone: form.time_timezone.trim(),
    }),
  });
  const [validationError, setValidationError] = createSignal<string | null>(null);
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [wifiScanItems, setWifiScanItems] = createSignal<WifiScanItem[]>([]);
  const [wifiScanning, setWifiScanning] = createSignal(false);
  const [wifiScanError, setWifiScanError] = createSignal<string | null>(null);

  createEffect(() => {
    void tab.form.wifi_ssid;
    void tab.form.wifi_password;
    void tab.form.ap_ssid;
    void tab.form.ap_password;
    setValidationError(null);
  });

  const handleSave = async () => {
    const wifiSsid = tab.form.wifi_ssid.trim();
    const wifiPassword = tab.form.wifi_password;
    const apPassword = tab.form.ap_password;

    if (!wifiSsid) {
      const message = t('wifiValidationSsidRequired') as string;
      setValidationError(message);
      pushToast(message, 'error', 5000);
      return;
    }

    if (wifiPassword.length > 0 && wifiPassword.length < 8) {
      const message = t('wifiValidationPasswordLength') as string;
      setValidationError(message);
      pushToast(message, 'error', 5000);
      return;
    }

    if (apPassword.length > 0 && apPassword.length < 8) {
      const message = t('apValidationPasswordLength') as string;
      setValidationError(message);
      pushToast(message, 'error', 5000);
      return;
    }

    await tab.save();
    setConfirmOpen(true);
  };

  const currentApSsid = () => appStatus()?.ap_ssid ?? '';

  const handleWifiScan = async () => {
    if (wifiScanning()) return;
    setWifiScanning(true);
    setWifiScanError(null);
    try {
      const items = await scanWifi();
      const unique = new Map<string, WifiScanItem>();
      for (const item of items) {
        if (!item.ssid.trim()) continue;
        const current = unique.get(item.ssid);
        if (!current || item.rssi > current.rssi) {
          unique.set(item.ssid, item);
        }
      }
      setWifiScanItems(
        Array.from(unique.values()).sort((a, b) => b.rssi - a.rssi),
      );
      if (unique.size === 0) {
        setWifiScanError(t('wifiScanEmpty') as string);
      }
    } catch (err) {
      const message = (err as Error).message || (t('wifiScanFailed') as string);
      setWifiScanError(message);
      pushToast(message, 'error', 5000);
    } finally {
      setWifiScanning(false);
    }
  };

  const apNameHint = () => {
    const ssid = currentApSsid();
    return ssid ? tf('apNameHint', { ssid }) : '';
  };

  const timezoneHint = () =>
    currentLocale() === 'zh-cn' ? (
      <>
        仅接受 POSIX TZ 字符串，符号与日常 UTC 表示相反。北京时间（UTC+8）应写作 "CST-8"
        ，纽约（UTC-5）写作 "EST5"。可在
        <a
          href="https://github.com/nayarsystems/posix_tz_db/blob/master/zones.csv"
          target="_blank"
          rel="noopener noreferrer"
          class="underline underline-offset-2 hover:text-[var(--color-text-primary)]"
        >
          此表格
        </a>
        查阅 IANA 时区与 POSIX 表达转换关系。
      </>
    ) : (
      (t('timezoneHelp') as string)
    );

  return (
    <TabShell>
      <PageHeader title={t('navBasic') as string} description={t('restartHint') as string} />
      <Show when={validationError() ?? tab.error()}>
        <div class="px-5 pt-4">
          <Banner kind="error" message={validationError() ?? tab.error() ?? undefined} />
        </div>
      </Show>
      <div class="divide-y divide-[var(--color-border-subtle)] mt-2">
        <StaticConfigBlock title={t('sectionWifi') as string}>
          <div class="grid gap-3 sm:grid-cols-2 pt-2">
            <div class="flex flex-col gap-2">
              <TextInput
                label={t('wifiSsid')}
                autocomplete="off"
                hint={t('wifiSsidHint') as string}
                value={tab.form.wifi_ssid}
                onInput={(event) => tab.setForm('wifi_ssid', event.currentTarget.value)}
              />
              <Button
                size="sm"
                variant="secondary"
                class="self-start"
                disabled={wifiScanning()}
                onClick={() => void handleWifiScan()}
              >
                {wifiScanning() ? t('wifiScanning') : t('wifiScan')}
              </Button>
            </div>
            <TextInput
              type="password"
              label={t('wifiPassword')}
              autocomplete="new-password"
              value={tab.form.wifi_password}
              onInput={(event) => tab.setForm('wifi_password', event.currentTarget.value)}
            />
            <TextInput
              label={t('apName')}
              autocomplete="off"
              hint={apNameHint()}
              value={tab.form.ap_ssid}
              onInput={(event) => tab.setForm('ap_ssid', event.currentTarget.value)}
            />
            <TextInput
              type="password"
              label={t('apPassword')}
              autocomplete="new-password"
              hint={t('apPasswordHint') as string}
              value={tab.form.ap_password}
              onInput={(event) => tab.setForm('ap_password', event.currentTarget.value)}
            />
            <SelectInput
              label={t('apBehavior')}
              value={tab.form.ap_behavior}
              onChange={(event) => tab.setForm('ap_behavior', event.currentTarget.value)}
            >
              <option value="keep">{t('apBehaviorKeep') as string}</option>
              <option value="close_on_sta">{t('apBehaviorCloseOnSta') as string}</option>
            </SelectInput>
          </div>
          <Show when={wifiScanError()}>
            <div class="mt-3 text-[0.78rem] text-[var(--color-orange)]">{wifiScanError()}</div>
          </Show>
          <Show when={wifiScanItems().length > 0}>
            <div class="mt-3 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-white/[0.02] overflow-hidden">
              <div class="px-3 py-2 text-[0.76rem] text-[var(--color-text-muted)] border-b border-[var(--color-border-subtle)]">
                {t('wifiScanResults')}
              </div>
              <div class="divide-y divide-[var(--color-border-subtle)] max-h-60 overflow-auto">
                <For each={wifiScanItems()}>
                  {(item) => (
                    <button
                      type="button"
                      class="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-white/[0.05] transition"
                      onClick={() => tab.setForm('wifi_ssid', item.ssid)}
                    >
                      <span class="min-w-0 flex-1 truncate text-sm text-[var(--color-text-primary)]">
                        {item.ssid}
                      </span>
                      <span class="shrink-0 text-[0.72rem] text-[var(--color-text-muted)]">
                        {item.rssi} dBm · CH {item.channel} · {item.auth}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </StaticConfigBlock>
        <CollapsibleConfigBlock title={t('sectionAdvanced') as string} defaultOpen={false}>
          <div class="pt-2">
            <TextInput
              full
              label={t('timezone')}
              placeholder={t('timezonePlaceholder') as string}
              hint={timezoneHint()}
              value={tab.form.time_timezone}
              onInput={(event) => tab.setForm('time_timezone', event.currentTarget.value)}
            />
          </div>
        </CollapsibleConfigBlock>
      </div>
      <SavePanel
        dirty={tab.dirty()}
        saving={tab.saving()}
        onSave={() => handleSave().catch(() => undefined)}
        onDiscard={tab.discard}
        note={t('restartHint') as string}
      />
      <RestartConfirmModal
        open={confirmOpen()}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          props.onRestartRequest();
        }}
        subtitle={t('restartHint') as string}
      />
    </TabShell>
  );
};
