import { createEffect, createSignal, Show, type Component } from 'solid-js';
import type { AppConfig } from '../api/client';
import { TabShell } from '../components/layout/TabShell';
import { Banner } from '../components/ui/Banner';
import { StaticConfigBlock } from '../components/ui/ConfigBlocks';
import { SelectInput, TextArea, TextInput } from '../components/ui/FormField';
import { PageHeader } from '../components/ui/PageHeader';
import { SavePanel } from '../components/ui/SavePanel';
import { t } from '../i18n';
import { createConfigTab } from '../state/configTab';
import { pushToast } from '../state/toast';

type PersonaId = 'hardware_mentor' | 'concise_engineer' | 'friendly_assistant' | 'custom';

type AgentForm = {
  agent_display_name: string;
  agent_owner_name: string;
  agent_owner_address: string;
  agent_persona_id: PersonaId;
  agent_custom_prompt: string;
};

const CUSTOM_PROMPT_MAX_LENGTH = 1023;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

export const AgentPage: Component = () => {
  const tab = createConfigTab<AgentForm>({
    tab: 'agent',
    groups: ['agent'],
    toForm: (config: Partial<AppConfig>) => ({
      agent_display_name: config.agent_display_name ?? 'Nova',
      agent_owner_name: config.agent_owner_name ?? 'Elon Xu',
      agent_owner_address: config.agent_owner_address ?? 'Elon',
      agent_persona_id: (config.agent_persona_id as PersonaId) || 'hardware_mentor',
      agent_custom_prompt: config.agent_custom_prompt ?? '',
    }),
    fromForm: (form) => ({
      agent_display_name: form.agent_display_name.trim(),
      agent_owner_name: form.agent_owner_name.trim(),
      agent_owner_address: form.agent_owner_address.trim(),
      agent_persona_id: form.agent_persona_id,
      agent_custom_prompt: form.agent_custom_prompt.trim(),
    }),
    saveMessage: () => t('agentSaveSuccess') as string,
  });
  const [validationError, setValidationError] = createSignal<string | null>(null);

  createEffect(() => {
    void tab.form.agent_display_name;
    void tab.form.agent_owner_name;
    void tab.form.agent_owner_address;
    void tab.form.agent_persona_id;
    void tab.form.agent_custom_prompt;
    setValidationError(null);
  });

  const personaDescription = () => {
    switch (tab.form.agent_persona_id) {
      case 'concise_engineer':
        return t('agentPersonaConciseDesc') as string;
      case 'friendly_assistant':
        return t('agentPersonaFriendlyDesc') as string;
      case 'custom':
        return t('agentPersonaCustomDesc') as string;
      default:
        return t('agentPersonaHardwareDesc') as string;
    }
  };

  const customPromptBytes = () => utf8Length(tab.form.agent_custom_prompt);

  const handleSave = async () => {
    if (
      !tab.form.agent_display_name.trim() ||
      !tab.form.agent_owner_name.trim() ||
      !tab.form.agent_owner_address.trim()
    ) {
      const message = t('agentValidationRequired') as string;
      setValidationError(message);
      pushToast(message, 'error', 5000);
      return;
    }
    if (
      utf8Length(tab.form.agent_display_name.trim()) > 47 ||
      utf8Length(tab.form.agent_owner_name.trim()) > 63 ||
      utf8Length(tab.form.agent_owner_address.trim()) > 47
    ) {
      const message = t('agentValidationIdentityLength') as string;
      setValidationError(message);
      pushToast(message, 'error', 5000);
      return;
    }
    if (tab.form.agent_persona_id === 'custom' && !tab.form.agent_custom_prompt.trim()) {
      const message = t('agentValidationCustom') as string;
      setValidationError(message);
      pushToast(message, 'error', 5000);
      return;
    }
    if (customPromptBytes() > CUSTOM_PROMPT_MAX_LENGTH) {
      const message = t('agentValidationCustomLength') as string;
      setValidationError(message);
      pushToast(message, 'error', 5000);
      return;
    }
    await tab.save();
  };

  return (
    <TabShell>
      <PageHeader title={t('navAgent') as string} description={t('agentPageDesc') as string} />
      <Show when={validationError() ?? tab.error()}>
        <div class="px-5 pt-4">
          <Banner kind="error" message={validationError() ?? tab.error() ?? undefined} />
        </div>
      </Show>
      <div class="divide-y divide-[var(--color-border-subtle)] mt-2">
        <StaticConfigBlock title={t('agentIdentitySection') as string}>
          <div class="grid gap-3 sm:grid-cols-2 pt-2">
            <TextInput
              label={t('agentDisplayName')}
              hint={t('agentDisplayNameHint')}
              maxlength={47}
              value={tab.form.agent_display_name}
              onInput={(event) => tab.setForm('agent_display_name', event.currentTarget.value)}
            />
            <TextInput
              label={t('agentOwnerName')}
              hint={t('agentOwnerNameHint')}
              maxlength={63}
              value={tab.form.agent_owner_name}
              onInput={(event) => tab.setForm('agent_owner_name', event.currentTarget.value)}
            />
            <TextInput
              label={t('agentOwnerAddress')}
              hint={t('agentOwnerAddressHint')}
              maxlength={47}
              value={tab.form.agent_owner_address}
              onInput={(event) => tab.setForm('agent_owner_address', event.currentTarget.value)}
            />
          </div>
        </StaticConfigBlock>

        <StaticConfigBlock title={t('agentPersonaSection') as string}>
          <div class="grid gap-3 sm:grid-cols-2 pt-2">
            <SelectInput
              label={t('agentPersona')}
              hint={personaDescription()}
              value={tab.form.agent_persona_id}
              onChange={(event) =>
                tab.setForm('agent_persona_id', event.currentTarget.value as PersonaId)
              }
            >
              <option value="hardware_mentor">{t('agentPersonaHardware')}</option>
              <option value="concise_engineer">{t('agentPersonaConcise')}</option>
              <option value="friendly_assistant">{t('agentPersonaFriendly')}</option>
              <option value="custom">{t('agentPersonaCustom')}</option>
            </SelectInput>
            <div class="rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-white/[0.025] px-4 py-3 text-[0.8rem] leading-5 text-[var(--color-text-secondary)]">
              {t('agentSafetyNote')}
            </div>
            <Show when={tab.form.agent_persona_id === 'custom'}>
              <TextArea
                full
                label={t('agentCustomPrompt')}
                hint={`${customPromptBytes()}/${CUSTOM_PROMPT_MAX_LENGTH} ${t('agentBytes')}`}
                inputClass="min-h-[180px]"
                value={tab.form.agent_custom_prompt}
                onInput={(event) => tab.setForm('agent_custom_prompt', event.currentTarget.value)}
              />
            </Show>
          </div>
        </StaticConfigBlock>
      </div>
      <SavePanel
        dirty={tab.dirty()}
        saving={tab.saving()}
        onSave={() => handleSave().catch(() => undefined)}
        onDiscard={tab.discard}
        note={t('agentRestartHint') as string}
      />
    </TabShell>
  );
};
