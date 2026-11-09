import { Keyboard } from 'grammy';
import { T } from './bot.texts';

export const contactKeyboard = () => new Keyboard().requestContact(T.sendContactButton).resized().oneTime();

// Подсказка имени — имя из профиля Telegram, можно написать своё.
export const nameKeyboard = (suggestion: string) => new Keyboard().text(suggestion).resized().oneTime();

export const menuKeyboard = () => new Keyboard().text(T.myCardButton).text(T.historyButton).resized().persistent();
