import React from 'react';

interface PanelProps {
  title?: React.ReactNode;
  hint?: React.ReactNode;
  badge?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}

/** Unified rounded-card section used across all Theme Studio tabs so the five
 *  tabs share one visual language (matching the Controls Group card shell). */
export const Panel: React.FC<PanelProps> = ({ title, hint, badge, className = '', bodyClassName = '', ariaLabel, children }) => (
  <section data-bp-panel="" aria-label={ariaLabel} className={`min-w-0 border-b border-white/10 pb-3 ${className}`}>
    {title && (
      <div className="flex items-baseline justify-between gap-2 pt-2">
        <h3 className="text-xs font-medium text-slate-200">{title}</h3>
        {badge ?? (hint && <span className="text-[10px] text-slate-400">{hint}</span>)}
      </div>
    )}
    <div className={`${title ? 'pt-2.5' : 'py-2'} ${bodyClassName}`}>{children}</div>
  </section>
);
