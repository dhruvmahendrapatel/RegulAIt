import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card } from "./kit";

/**
 * Contains one dashboard card's render failure to that card. Without it, a
 * single malformed or partial response (one endpoint answering an unexpected
 * shape) unmounts the whole page — the home page went blank because one tile
 * read `.length` of a missing list. The card says it could not load and
 * offers a retry; everything around it keeps working.
 */
export class CardBoundary extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`card "${this.props.title}" failed to render`, error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Card title={this.props.title}>
        <p role="status">
          This card couldn't load.{" "}
          <Button size="sm" variant="ghost" onClick={() => this.setState({ failed: false })}>
            Try again
          </Button>
        </p>
      </Card>
    );
  }
}
