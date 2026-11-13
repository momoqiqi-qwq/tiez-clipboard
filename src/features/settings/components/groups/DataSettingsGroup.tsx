import { open, ask, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { CollapseChevron } from "../CollapseChevron";

interface DataSettingsGroupProps {
    t: (key: string) => string;
    collapsed: boolean;
    onToggle: () => void;
    dataPath: string;
    appSettings: Record<string, string>;
    saveAppSetting: (key: string, value: string) => void;
}

const DataSettingsGroup = ({ t, collapsed, onToggle, dataPath, appSettings, saveAppSetting }: DataSettingsGroupProps) => (
    <div className={`settings-group ${collapsed ? 'collapsed' : ''}`}>
        <div className="group-header" onClick={onToggle}>
            <h3 style={{ margin: 0 }}>{t('data_management')}</h3>
            <CollapseChevron collapsed={collapsed} />
        </div>
        {!collapsed && (
            <div className="group-content">
                <div className="setting-item column no-border">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <span className="item-label" style={{ textTransform: 'uppercase', fontSize: '11px', opacity: 0.8 }}>{t('data_path')}</span>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                                className="btn-icon"
                                onClick={() => {
                                    open({
                                        directory: true,
                                        multiple: false,
                                        title: t('change_data_path')
                                    }).then(async (selected) => {
                                        if (selected) {
                                            const newPath = selected as string;
                                            const confirm = await ask(
                                                t('data_move_confirm').replace('{path}', newPath),
                                                { title: t('change_data_path'), kind: 'warning', okLabel: t('confirm'), cancelLabel: t('cancel') }
                                            );

                                            if (confirm) {
                                                try {
                                                    // Logic Update:
                                                    // We DO NOT copy the file here because the DB is locked/in-use.
                                                    // Instead, we just set the path and restart.
                                                    // The backend 'main.rs' startup logic will handle the migration (copying)
                                                    // if it detects a custom path with no DB using the default DB as source.

                                                    await invoke("set_data_path", { newPath });

                                                    await message(
                                                        t('data_move_success'),
                                                        { title: t('notice'), kind: 'info' }
                                                    );

                                                    await invoke("relaunch");
                                                } catch (e: unknown) {
                                                    console.error(e);
                                                    const errorMsg = e instanceof Error ? e.message : String(e);
                                                    await message(
                                                        t('data_move_failed').replace('{e}', errorMsg),
                                                        { title: t('error'), kind: 'error' }
                                                    );
                                                }
                                            }
                                        }
                                    });
                                }}
                                style={{ width: 'auto', padding: '4px 12px', fontSize: '10px', textTransform: 'uppercase', height: '24px' }}
                            >
                                {t('change_app')}
                            </button>
                            <button
                                className="btn-icon"
                                onClick={() => invoke("open_data_folder").catch(console.error)}
                                title={t('open_folder') || "Open"}
                                style={{ width: 'auto', padding: '4px 12px', fontSize: '10px', textTransform: 'uppercase', height: '24px' }}
                            >
                                {t('open_folder')}
                            </button>
                        </div>
                    </div>
                    <div className="data-panel" style={{ fontSize: '11px', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                        {dataPath}
                    </div>

                    <div className="setting-item column" style={{ marginTop: '12px', borderBottom: 'none' }}>
                        <div className="item-label-group">
                            <span className="item-label">{t('config_backup')}</span>
                            <span className="hint">{t('config_backup_hint')}</span>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                            <button
                                className="btn-icon"
                                onClick={async () => {
                                    const selected = await open({ directory: true, multiple: false, title: t('choose_backup_folder') });
                                    if (typeof selected === 'string') saveAppSetting('config_backup_dir', selected);
                                }}
                                style={{ width: 'auto', padding: '4px 12px', fontSize: '10px', textTransform: 'uppercase', height: '24px' }}
                            >
                                {t('choose_backup_folder')}
                            </button>
                            <button
                                className="btn-icon"
                                onClick={() => invoke('export_config_now')
                                    .then((path) => message(`${t('config_export_success')}: ${path}`, { title: t('notice'), kind: 'info' }))
                                    .catch((error) => message(String(error), { title: t('error'), kind: 'error' }))}
                                style={{ width: 'auto', padding: '4px 12px', fontSize: '10px', textTransform: 'uppercase', height: '24px' }}
                            >
                                {t('export_config')}
                            </button>
                            <button
                                className="btn-icon"
                                onClick={async () => {
                                    const selected = await open({
                                        directory: false,
                                        multiple: false,
                                        title: t('import_config'),
                                        filters: [{ name: 'TieZ Config', extensions: ['json'] }]
                                    });
                                    if (typeof selected !== 'string') return;
                                    try {
                                        const count = await invoke<number>('import_config', { filePath: selected });
                                        await message(`${t('config_import_success')} (${count})`, { title: t('notice'), kind: 'info' });
                                        await invoke('relaunch');
                                    } catch (error) {
                                        await message(String(error), { title: t('error'), kind: 'error' });
                                    }
                                }}
                                style={{ width: 'auto', padding: '4px 12px', fontSize: '10px', textTransform: 'uppercase', height: '24px' }}
                            >
                                {t('import_config')}
                            </button>
                        </div>
                        <div className="data-panel" style={{ fontSize: '11px', color: 'var(--text-secondary)', wordBreak: 'break-all', marginTop: '8px' }}>
                            {appSettings['app.config_backup_dir'] || t('backup_folder_not_set')}
                        </div>
                        <div className="setting-item" style={{ paddingLeft: 0, paddingRight: 0 }}>
                            <span className="item-label">{t('scheduled_backup')}</span>
                            <label className="switch">
                                <input
                                    className="cb"
                                    type="checkbox"
                                    checked={appSettings['app.config_backup_enabled'] === 'true'}
                                    onChange={(event) => saveAppSetting('config_backup_enabled', String(event.target.checked))}
                                />
                                <div className="toggle"><div className="left" /><div className="right" /></div>
                            </label>
                        </div>
                        <div className="setting-item" style={{ paddingLeft: 0, paddingRight: 0 }}>
                            <span className="item-label">{t('backup_interval')}</span>
                            <input
                                type="number"
                                min={1}
                                max={10080}
                                value={appSettings['app.config_backup_interval_min'] || '60'}
                                onChange={(event) => saveAppSetting('config_backup_interval_min', event.target.value)}
                                style={{ width: '90px' }}
                            />
                        </div>
                        <div className="setting-item" style={{ paddingLeft: 0, paddingRight: 0 }}>
                            <span className="item-label">{t('backup_on_exit')}</span>
                            <label className="switch">
                                <input
                                    className="cb"
                                    type="checkbox"
                                    checked={appSettings['app.config_backup_on_exit'] !== 'false'}
                                    onChange={(event) => saveAppSetting('config_backup_on_exit', String(event.target.checked))}
                                />
                                <div className="toggle"><div className="left" /><div className="right" /></div>
                            </label>
                        </div>
                    </div>
                </div>
            </div>
        )}
    </div>
);

export default DataSettingsGroup;
