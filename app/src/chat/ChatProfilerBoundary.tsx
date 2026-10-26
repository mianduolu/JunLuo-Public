import { Fragment, Profiler, type ReactNode } from 'react';

import {
  CHAT_PERFORMANCE_DIAGNOSTICS_ENABLED,
  recordChatProfilerRender,
} from './chatPerformanceDiagnostics';

type ChatProfilerBoundaryProps = {
  children: ReactNode;
  id: 'ChatShell' | 'ChatMessageList' | 'ChatComposer' | 'ChatPanels';
};

export function ChatProfilerBoundary({ children, id }: ChatProfilerBoundaryProps) {
  if (!CHAT_PERFORMANCE_DIAGNOSTICS_ENABLED) {
    return <Fragment>{children}</Fragment>;
  }

  return (
    <Profiler id={id} onRender={(_id, _phase, actualDuration) => recordChatProfilerRender(id, actualDuration)}>
      {children}
    </Profiler>
  );
}

