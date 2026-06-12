const LOG_PREFIX = '[ChatRecap]';
const MODULE_NAME = 'ChatRecap';
const CHAT_CHANGE_DELAY_MS = 300;
const INITIAL_CHECK_DELAY_MS = 500;
const MAX_HISTORY_MESSAGES = 2000;
const MAX_HISTORY_CHARS = 200000; // Intentionally higher; covers long RP sessions

const defaultSettings = Object.freeze({
    thresholdHours: 24,
    promptTemplate: 'You are a concise summarizer. Give a brief informal narrative summary of what happened in this chat for someone coming back after time away. Write as a flowing story — no bullet points or lists. Focus on key events, character development, and emotional moments.\n\n{{messages}}',
    showTimeAway: true,
    connectionProfile: '',
});

let isGenerating = false;
let currentPopup = null;
let lastRecapShownChatId = null;
let pendingGeneration = null;
let scriptModule = null;
let extensionsModule = null;
let popupModule = null;
let i18nModule = null;
let connectionManagerService = null;
let DOMPurify = null;

function log(...args) {
    console.log(LOG_PREFIX, ...args);
}

async function loadModule(paths) {
    for (const path of paths) {
        try {
            return await import(path);
        } catch (e) {
            continue;
        }
    }
    throw new Error(`Failed to load module from any path: ${paths.join(', ')}`);
}

async function initModules() {
    scriptModule = await loadModule(['../../../script.js', '../../../../script.js']);
    extensionsModule = await loadModule(['../../extensions.js', '../../../extensions.js']);
    popupModule = await loadModule(['../../popup.js', '../../../popup.js']);
    try {
        const sharedModule = await loadModule(['../shared.js', '../../shared.js']);
        connectionManagerService = sharedModule?.ConnectionManagerRequestService || null;
        log('ConnectionManagerRequestService loaded:', !!connectionManagerService);
    } catch (e) {
        log('ConnectionManagerRequestService not available:', e.message);
        connectionManagerService = null;
    }
    try {
        i18nModule = await loadModule(['../../../i18n.js', '../../../../i18n.js']);
        log('i18n module loaded:', !!i18nModule);
    } catch (e) {
        log('i18n module not available:', e.message);
        i18nModule = null;
    }
    try {
        const libModule = await loadModule(['../../../lib.js', '../../../../lib.js']);
        DOMPurify = libModule?.DOMPurify || window.DOMPurify || null;
        log('DOMPurify loaded:', !!DOMPurify);
    } catch (e) {
        log('DOMPurify not available:', e.message);
        DOMPurify = window.DOMPurify || null;
    }
}

function getSettings() {
    const { extension_settings } = extensionsModule;
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extension_settings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = structuredClone(defaultSettings[key]);
        }
    }
    return s;
}

function saveSettings() {
    const { saveSettingsDebounced } = scriptModule;
    saveSettingsDebounced();
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function getLastMessageTime(ctx) {
    if (!ctx.chat?.length) return null;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const msg = ctx.chat[i];
        if (msg.is_system) continue;
        if (msg.send_date) {
            const ts = new Date(msg.send_date).getTime();
            if (!isNaN(ts)) return ts;
        }
    }
    return null;
}

function formatTimeAway(timestamp) {
    if (!timestamp || typeof timestamp !== 'number') return '';
    const hours = (Date.now() - timestamp) / (1000 * 60 * 60);
    const { translate } = i18nModule || {};
    const _t = (key, val) => {
        if (!translate) return val;
        try {
            return translate(val, key);
        } catch (_e) {
            return val;
        }
    };
    if (hours < 1) {
        const mins = Math.round(hours * 60);
        return _t(mins === 1 ? 'CR_Time_MinuteAgo' : 'CR_Time_MinutesAgo', mins === 1 ? '{0} minute ago' : '{0} minutes ago').replace('{0}', mins);
    }
    if (hours < 24) {
        const h = Math.round(hours);
        return _t(h === 1 ? 'CR_Time_HourAgo' : 'CR_Time_HoursAgo', h === 1 ? '{0} hour ago' : '{0} hours ago').replace('{0}', h);
    }
    const days = Math.round(hours / 24);
    if (days < 7) {
        return _t(days === 1 ? 'CR_Time_DayAgo' : 'CR_Time_DaysAgo', days === 1 ? '{0} day ago' : '{0} days ago').replace('{0}', days);
    }
    const weeks = Math.round(days / 7);
    if (weeks < 5) {
        return _t(weeks === 1 ? 'CR_Time_WeekAgo' : 'CR_Time_WeeksAgo', weeks === 1 ? '{0} week ago' : '{0} weeks ago').replace('{0}', weeks);
    }
    const months = Math.round(days / 30);
    if (months < 12) {
        return _t(months === 1 ? 'CR_Time_MonthAgo' : 'CR_Time_MonthsAgo', months === 1 ? '{0} month ago' : '{0} months ago').replace('{0}', months);
    }
    const years = Math.round(days / 365);
    return _t(years === 1 ? 'CR_Time_YearAgo' : 'CR_Time_YearsAgo', years === 1 ? '{0} year ago' : '{0} years ago').replace('{0}', years);
}

function buildChatHistory() {
    const { getContext } = extensionsModule;
    const ctx = getContext();
    if (!ctx?.chat?.length) return '';
    const msgs = ctx.chat.filter(m => !m.is_system);
    const slice = msgs.length > MAX_HISTORY_MESSAGES ? msgs.slice(-MAX_HISTORY_MESSAGES) : msgs;
    let history = slice.map(m => `${m.is_user ? (ctx.name1 || 'User') : (m.name || 'Character')}: ${m.mes || ''}`).join('\n\n');
    if (history.length > MAX_HISTORY_CHARS) {
        log(`History trimmed from ${history.length} to ${MAX_HISTORY_CHARS} chars`);
        history = history.slice(-MAX_HISTORY_CHARS);
    }
    return history;
}

async function generateRecap(history) {
    const s = getSettings();
    const prompt = s.promptTemplate.replace('{{messages}}', history);
    try {
        // If user selected a connection profile, use ConnectionManagerRequestService
        if (s.connectionProfile && connectionManagerService) {
            log('Using connection profile:', s.connectionProfile);
            const messages = [
                { role: 'user', content: prompt }
            ];
            const response = await connectionManagerService.sendRequest(
                s.connectionProfile,
                messages,
                undefined, // Let connection profile control max tokens
                { extractData: true, stream: false }
            );
            log('ConnectionManager response type:', typeof response, '| has content:', !!response?.content, '| has reasoning:', !!response?.reasoning);
            const content = response?.content || '';
            let reasoning = response?.reasoning || '';
            // Defensive: reasoning may be an object or non-string in some APIs
            if (typeof reasoning !== 'string') {
                log('Reasoning is not a string, type:', typeof reasoning, '| value:', JSON.stringify(reasoning).substring(0, 200));
                reasoning = String(reasoning || '');
            }
            log('Content length:', content?.length || 0, '| Reasoning length:', reasoning?.length || 0);
            // If content is empty but reasoning is present, use reasoning as fallback
            if (!content?.trim() && reasoning?.trim()) {
                log('WARNING: content is empty but reasoning is present. Using reasoning as fallback.');
                if (typeof toastr !== 'undefined') {
                    toastr.info('Reasoning output used as summary. Disable "Request Model Reasoning" in your preset for cleaner recaps.', 'ChatRecap');
                }
                const result = reasoning.trim();
                log('Final result length:', result.length, 'chars');
                return result;
            }
            const result = content?.trim() || null;
            log('Final result:', result === null ? 'null' : result.length + ' chars');
            return result;
        }

        const { translate } = i18nModule || {};
        const msg = translate ? translate('Please select a connection profile in ChatRecap settings to generate recaps.', 'CR_Warning_NoProfile') : 'Please select a connection profile in ChatRecap settings to generate recaps.';
        const title = translate ? translate('ChatRecap', 'CR_Warning_NoProfile_Title') : 'ChatRecap';
        if (typeof toastr !== 'undefined') {
            toastr.warning(msg, title);
        }
        log('No connection profile selected — cannot generate recap');
        return null;
    } catch (e) {
        log('Generation failed:', e);
        return null;
    }
}

async function showRecap(summary, timeAwayText) {
    if (currentPopup) {
        try { currentPopup.completeCancelled(); } catch (_e) {}
        currentPopup = null;
    }
    const { POPUP_TYPE, Popup } = popupModule;
    const { translate } = i18nModule || {};
    const title = translate ? translate('Where you left off', 'CR_Popup_Title') : 'Where you left off';
    const lastSeen = timeAwayText && translate
        ? translate('Last seen ${0}', 'CR_Popup_LastSeen').replace(/\$\{0\}/g, escapeHtml(timeAwayText))
        : (timeAwayText ? `Last seen ${escapeHtml(timeAwayText)}` : '');
    const { converter } = scriptModule || {};
    let summaryHtml;
    if (converter) {
        let mes = summary;
        // Wrap quotes in <q> tags (same as SillyTavern's messageFormatting)
        mes = mes.replace(/<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim, function (match, p1, p2, p3, p4, p5, p6) {
            if (p1) return `<q>"${p1.slice(1, -1)}"</q>`;
            else if (p2) return `<q>"${p2.slice(1, -1)}"</q>`;
            else if (p3) return `<q>«${p3.slice(1, -1)}»</q>`;
            else if (p4) return `<q>「${p4.slice(1, -1)}」</q>`;
            else if (p5) return `<q>『${p5.slice(1, -1)}』</q>`;
            else if (p6) return `<q>＂${p6.slice(1, -1)}＂</q>`;
            else return match;
        });
        const markdownHtml = converter.makeHtml(mes);
        summaryHtml = DOMPurify ? DOMPurify.sanitize(markdownHtml) : escapeHtml(summary).replace(/\n/g, '<br>');
    } else {
        summaryHtml = escapeHtml(summary).replace(/\n/g, '<br>');
    }
    const html = `
        <div class="chat-recap-container">
            <h2 class="recap-title">${escapeHtml(title)}</h2>
            <hr class="recap-divider">
            ${lastSeen ? `<div class="recap-time">${lastSeen}</div>` : ''}
            <div class="recap-body"><div class="mes_text">${summaryHtml}</div></div>
            <button class="recap-close-button menu_button" data-i18n="CR_Popup_Close">Close</button>
        </div>`;
    const popup = new Popup(html, POPUP_TYPE.DISPLAY, null, {
        wide: true,
        allowVerticalScrolling: true,
        animation: 'slow',
        onOpen: (dlg) => {
            // Hide the default X close button since we have our own
            const xBtn = dlg.dlg?.querySelector('.popup-button-close');
            if (xBtn) xBtn.style.display = 'none';
            
            const btn = dlg.content.querySelector('.recap-close-button');
            if (btn) btn.addEventListener('click', () => dlg.completeCancelled());
        },
    });
    currentPopup = popup;
    const { getCurrentChatId } = scriptModule;
    lastRecapShownChatId = getCurrentChatId?.() || null;
    popup.show().then(() => { currentPopup = null; }).catch(e => { log('Popup error:', e); currentPopup = null; });
}

function showPlaceholder(timeAwayText) {
    if (currentPopup) {
        try { currentPopup.completeCancelled(); } catch (_e) {}
        currentPopup = null;
    }
    const { POPUP_TYPE, Popup } = popupModule;
    const { translate } = i18nModule || {};
    const title = translate ? translate('Where you left off', 'CR_Popup_Title') : 'Where you left off';
    const lastSeen = timeAwayText && translate
        ? translate('Last seen ${0}', 'CR_Popup_LastSeen').replace(/\$\{0\}/g, escapeHtml(timeAwayText))
        : (timeAwayText ? `Last seen ${escapeHtml(timeAwayText)}` : '');
    const generatingText = translate ? translate('Generating summary...', 'CR_Popup_Generating') : 'Generating summary...';
    const subText = translate ? translate('This may take a moment depending on your endpoint', 'CR_Popup_GeneratingSub') : 'This may take a moment depending on your endpoint';
    
    const html = `
        <div class="chat-recap-container">
            <h2 class="recap-title">${escapeHtml(title)}</h2>
            <hr class="recap-divider">
            ${lastSeen ? `<div class="recap-time">${lastSeen}</div>` : ''}
            <div class="recap-body recap-placeholder" role="status" aria-label="Loading summary">
                <div class="recap-spinner">
                    <i class="fa-solid fa-circle-notch fa-spin"></i>
                </div>
                <div class="recap-placeholder-text">${escapeHtml(generatingText)}</div>
                <div class="recap-placeholder-sub">${escapeHtml(subText)}</div>
            </div>
            <button class="recap-close-button menu_button" data-i18n="CR_Popup_Close">Close</button>
        </div>`;
    
    const popup = new Popup(html, POPUP_TYPE.DISPLAY, null, {
        wide: true,
        allowVerticalScrolling: true,
        animation: 'slow',
        onOpen: (dlg) => {
            const xBtn = dlg.dlg?.querySelector('.popup-button-close');
            if (xBtn) xBtn.style.display = 'none';
            const btn = dlg.content.querySelector('.recap-close-button');
            if (btn) btn.addEventListener('click', () => dlg.completeCancelled());
        },
    });
    
    currentPopup = popup;
    pendingGeneration = popup;
    popup.show().then(() => { 
        if (currentPopup === popup) currentPopup = null;
        pendingGeneration = null;
    }).catch(e => { 
        log('Placeholder popup error:', e); 
        if (currentPopup === popup) currentPopup = null;
        pendingGeneration = null;
    });
}

async function checkAndShowRecap(force = false) {
    try {
        if (isGenerating) { log('Already generating, skipping'); return; }
        isGenerating = true;
        const { getContext } = extensionsModule;
        const { getCurrentChatId } = scriptModule;
        const ctx = getContext();
        if (!ctx?.chat?.length) { log('Chat not loaded, skipping'); isGenerating = false; return; }
        const chatKey = getCurrentChatId?.() || null;
        if (!chatKey) { log('No chat key, skipping'); isGenerating = false; return; }

        const lastMessageTime = getLastMessageTime(ctx);

        const now = Date.now();

        const s = getSettings();

        // If no messages yet, skip
        if (!lastMessageTime && !force) {
            log('No messages yet, skipping');
            isGenerating = false;
            return;
        }

        // Calculate time since last message
        const hoursSinceMessage = lastMessageTime ? (now - lastMessageTime) / (1000 * 60 * 60) : Infinity;

        // Skip if not enough time has passed since last message
        if (!force && hoursSinceMessage < s.thresholdHours) {
            log(`${hoursSinceMessage.toFixed(1)}h since last message < ${s.thresholdHours}h threshold, skipping`);
            isGenerating = false;
            return;
        }

        log(force ? 'Forced recap generation' : `${hoursSinceMessage.toFixed(1)}h since last message, generating recap`);
        const history = buildChatHistory();
        log('History length:', history.length, 'chars');
        if (!history.trim()) {
            log('No history available');
            isGenerating = false;
            return;
        }

        // Show placeholder immediately so user knows what's happening
        const timeAway = s.showTimeAway ? formatTimeAway(lastMessageTime) : '';
        showPlaceholder(timeAway);

        const summary = await generateRecap(history);
        
        if (getCurrentChatId?.() !== chatKey) { 
            log('Chat changed, discarding'); 
            isGenerating = false; 
            return; 
        }
        
        // If user closed the placeholder, discard the summary
        if (!pendingGeneration) {
            log('Popup was cancelled, discarding summary');
            isGenerating = false;
            return;
        }
        
        if (summary) {
            log('Got summary, showing popup');
            // Close placeholder before showing real summary
            if (currentPopup && currentPopup === pendingGeneration) {
                try { currentPopup.completeCancelled(); } catch (_e) {}
                currentPopup = null;
            }
            await showRecap(summary, timeAway);
        } else {
            // Generation returned empty
            if (currentPopup && currentPopup === pendingGeneration) {
                try { currentPopup.completeCancelled(); } catch (_e) {}
                currentPopup = null;
            }
            if (typeof toastr !== 'undefined') {
                toastr.error('No summary returned from LLM. Check your connection profile and preset settings.', 'ChatRecap');
            }
        }

    } catch (e) {
        log('Error in checkAndShowRecap:', e);
        if (typeof toastr !== 'undefined') {
            toastr.error('Failed to generate recap. Check console for details.', 'ChatRecap');
        }
        // Close placeholder on error
        if (currentPopup && currentPopup === pendingGeneration) {
            try { currentPopup.completeCancelled(); } catch (_e) {}
            currentPopup = null;
        }
    } finally {
        isGenerating = false;
        pendingGeneration = null;
    }
}

function onChatChanged(_eventData) {
    try {
        const { getCurrentChatId } = scriptModule;
        const currentChatId = getCurrentChatId?.() || null;
        // Skip recap if this is just a chat reload (same chat ID) and we already showed a recap for it
        if (currentChatId && currentChatId === lastRecapShownChatId) {
            log('Chat reload for same chat, skipping recap');
            return;
        }
        if (isGenerating) log('Generation aborted - chat changed');
        if (currentPopup) { try { currentPopup.completeCancelled(); } catch (_e) {} currentPopup = null; }
        isGenerating = false;
        pendingGeneration = null;
        setTimeout(() => checkAndShowRecap(), CHAT_CHANGE_DELAY_MS);
    } catch (e) {
        log('Error in onChatChanged:', e);
        isGenerating = false;
        pendingGeneration = null;
    }
}

function initSettings() {
    const container = document.querySelector('#extensions_settings');
    if (!container) { log('Settings container not found'); return; }

    const s = getSettings();

    const html = `
        <div id="chatrecap_settings" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <div class="flex-container alignitemscenter margin0">
                        <b>Chat Recap</b>
                    </div>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="chat-recap-settings">
                        <div class="chat-recap-setting-row">
                            <label for="chatrecap_connection_profile" data-i18n="CR_Settings_ConnectionProfile">Connection Profile</label>
                            <select id="chatrecap_connection_profile" class="text_pole">
                                <option value="" data-i18n="CR_Settings_DefaultConnection">Select a profile...</option>
                            </select>
                        </div>
                        <hr>
                        <div class="chat-recap-setting-row chat-recap-setting-row-inline">
                            <div class="chat-recap-inline-group">
                                <label for="chatrecap_threshold" data-i18n="CR_Settings_TimeThreshold">Time Threshold (hours)</label>
                                <input id="chatrecap_threshold" type="number" class="neo-range-input" min="0" step="1" value="${escapeHtml(s.thresholdHours)}">
                            </div>
                        </div>
                        <div class="chat-recap-setting-row">
                            <label for="chatrecap_show_time" class="checkbox_label">
                                <input id="chatrecap_show_time" type="checkbox" ${s.showTimeAway ? 'checked' : ''}>
                                <span data-i18n="CR_Settings_ShowTimeAway">Show Time Away Label</span>
                            </label>
                        </div>
                        <hr>
                        <div class="chat-recap-setting-row">
                            <div class="flex-container alignitemscenter wide100p gap5px">
                                <label data-i18n="CR_Settings_PromptTemplate">Prompt Template</label>
                                <span class="fa-solid fa-circle-info opacity50p" data-i18n="[title]CR_Tooltip_Placeholder" title="Use {{messages}} as placeholder for chat history"></span>
                                <div class="editor_maximize fa-solid fa-maximize right_menu_button interactable" data-for="chatrecap_template" title="Maximize"></div>
                            </div>
                            <textarea id="chatrecap_template" class="text_pole textarea_compact wide100p" rows="4" data-i18n="[placeholder]CR_Textarea_Placeholder" placeholder="e.g., Summarize the key events, character development, and emotional moments...">${escapeHtml(s.promptTemplate)}</textarea>
                        </div>
                        <div class="chat-recap-setting-row">
                            <button id="chatrecap_test" class="menu_button" style="width:100%" data-i18n="CR_Settings_TestRecap">Test Recap Now</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const settingsEl = tempDiv.firstElementChild;
    container.appendChild(settingsEl);

    const testBtn = settingsEl.querySelector('#chatrecap_test');
    const profileSelect = settingsEl.querySelector('#chatrecap_connection_profile');
    const thresholdInput = settingsEl.querySelector('#chatrecap_threshold');
    const showTimeCheck = settingsEl.querySelector('#chatrecap_show_time');
    const templateArea = settingsEl.querySelector('#chatrecap_template');

    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            log('Manual test triggered');
            const originalText = testBtn.textContent || 'Test Recap Now';
            testBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + originalText;
            testBtn.disabled = true;
            try {
                await checkAndShowRecap(true);
            } finally {
                testBtn.textContent = originalText;
                testBtn.disabled = false;
            }
        });
    }

    if (profileSelect && connectionManagerService) {
        try {
            connectionManagerService.handleDropdown(
                '#chatrecap_connection_profile',
                s.connectionProfile,
                (profile) => {
                    s.connectionProfile = profile?.id || '';
                    saveSettings();
                    log('Selected profile:', s.connectionProfile || '(default)');
                }
            );
        } catch (e) {
            log('Failed to initialize profile dropdown:', e.message);
        }
    }

    if (thresholdInput) {
        thresholdInput.addEventListener('change', () => {
            const val = parseFloat(thresholdInput.value);
            s.thresholdHours = Number.isFinite(val) && val > 0 ? Math.min(val, 8760) : s.thresholdHours;
            saveSettings();
        });
    }
    if (showTimeCheck) {
        showTimeCheck.addEventListener('change', () => {
            s.showTimeAway = showTimeCheck.checked;
            saveSettings();
        });
    }
    if (templateArea) {
        templateArea.addEventListener('input', () => {
            s.promptTemplate = templateArea.value;
            saveSettings();
        });
    }

    log('Settings UI initialized');
}

export async function init() {
    log('Initializing v1.4.0');
    await initModules();
    initSettings();
    const { eventSource, event_types } = scriptModule;
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    log('Event listener attached: CHAT_CHANGED');
    const { getContext } = extensionsModule;
    const { getCurrentChatId } = scriptModule;
    const ctx = getContext();
    if (ctx?.chat?.length && getCurrentChatId?.()) {
        log('Chat already loaded, triggering initial check');
        setTimeout(() => checkAndShowRecap(), INITIAL_CHECK_DELAY_MS);
    }
}
