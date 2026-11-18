import React from 'react';
import { useLanguage } from '../utils/language-store';
import { canvasMessage } from '../utils/canvas-messages';

interface ErrorOverlayProps {
  error: string | null;
  setError: (val: string | null) => void;
}

export const ErrorOverlay: React.FC<ErrorOverlayProps> = ({ error, setError }) => {
  const language = useLanguage();
  if (!error) return null;

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 p-3 bg-red-100 border border-red-400 text-red-700 rounded-[var(--bp-ui-radius)] shadow-lg flex items-center max-w-lg">
      <span className="flex-grow">{canvasMessage(error, language)}</span>
      <button aria-label={language === 'zho' ? '关闭提示' : 'Dismiss message'} onClick={() => setError(null)} className="ml-4 p-1 rounded-full hover:bg-red-200">
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414-4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"></path>
        </svg>
      </button>
    </div>
  );
};
