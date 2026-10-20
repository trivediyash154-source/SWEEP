import { Component, type ReactNode } from 'react';

/** Shows `fallback` instead of a blank page when a 3D scene cannot start (for example, WebGL context creation fails). */
export class WebGLBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
