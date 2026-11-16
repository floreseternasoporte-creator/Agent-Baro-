// @ts-check

/** @typedef {'chat' | 'files' | 'tasks' | 'settings'} ScreenName */

/**
 * Acciones globales existentes del frontend. Son opcionales porque esta vista
 * puede cargar durante una actualización parcial o antes de script.js.
 * @typedef {object} ShellActions
 * @property {(() => void) | undefined} [clearChat]
 * @property {((screen: ScreenName) => void) | undefined} [showScreen]
 * @property {((message: string) => void) | undefined} [showToast]
 */

/** @type {Readonly<{newChatButtonId: string, chatScreen: ScreenName, errorMessage: string}>} */
const SHELL_CONFIG = Object.freeze({
  newChatButtonId: 'new-chat-btn',
  chatScreen: 'chat',
  errorMessage: 'No se pudo iniciar una conversación. Intenta recargar la app.',
});

/**
 * @param {Element | null} element
 * @returns {element is HTMLButtonElement}
 */
function isButton(element) {
  return element !== null && element.tagName === 'BUTTON';
}

/**
 * @param {ShellActions} actions
 * @returns {actions is ShellActions & {clearChat: () => void, showScreen: (screen: ScreenName) => void}}
 */
function hasNewChatActions(actions) {
  return typeof actions.clearChat === 'function' && typeof actions.showScreen === 'function';
}

/**
 * Informa el fallo sin dejar que un toast defectuoso rompa la interfaz.
 * @param {ShellActions} actions
 * @param {unknown} error
 */
function reportNewChatError(actions, error) {
  try {
    console.error('Baro: no se pudo iniciar una conversación.', error);
  } catch {
    // Un logger no disponible no debe bloquear la interfaz.
  }

  if (typeof actions.showToast !== 'function') return;

  try {
    actions.showToast(SHELL_CONFIG.errorMessage);
  } catch (toastError) {
    try {
      console.error('Baro: tampoco se pudo mostrar el aviso de error.', toastError);
    } catch {
      // El fallo del canal de aviso ya quedó aislado.
    }
  }
}

/**
 * @param {ShellActions} actions
 * @returns {() => void}
 */
function createNewChatHandler(actions) {
  return function handleNewChat() {
    if (!hasNewChatActions(actions)) {
      reportNewChatError(actions, new Error('Faltan las acciones del chat.'));
      return;
    }

    try {
      actions.clearChat();
      actions.showScreen(SHELL_CONFIG.chatScreen);
    } catch (error) {
      reportNewChatError(actions, error);
    }
  };
}

/**
 * Enlaza la acción de inicio sin asumir que el marcado ya está disponible.
 * @param {Document} documentRef
 * @param {ShellActions} actions
 * @returns {boolean} Indica si el control quedó enlazado.
 */
function initializeAppShell(documentRef, actions) {
  const button = documentRef.getElementById(SHELL_CONFIG.newChatButtonId);
  if (!isButton(button)) {
    reportNewChatError(actions, new Error('No se encontró el botón de nueva conversación.'));
    return false;
  }

  button.addEventListener('click', createNewChatHandler(actions));
  return true;
}

initializeAppShell(document, /** @type {ShellActions} */ (/** @type {unknown} */ (window)));
