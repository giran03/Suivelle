import { Component, type ErrorInfo, type ReactNode } from "react";

/** Keeps one failing component from blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error" role="alert">
        <span>
          {this.props.label ?? "Something went wrong."} {this.state.error.message}
        </span>
        <button onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
