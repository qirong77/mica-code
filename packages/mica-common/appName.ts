declare const __MICA_APP_NAME__: string | undefined;

/** 当前二进制对应的命令行命令名：mica / studio（构建时由 --define __MICA_APP_NAME__ 注入）。 */
export const APP_NAME =
  typeof __MICA_APP_NAME__ === 'string' && __MICA_APP_NAME__.length > 0 ? __MICA_APP_NAME__ : 'mica';

/** 产品显示名（版本输出等）：Mica Code / Studio。 */
export const APP_DISPLAY_NAME = APP_NAME === 'mica' ? 'Mica Code' : 'Studio';

/** 终端标题短名：Mica / Studio。 */
export const APP_TITLE_NAME = APP_NAME === 'mica' ? 'Mica' : 'Studio';
