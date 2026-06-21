import * as React from 'react';

export function Button({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return React.createElement('button', props, children);
}
