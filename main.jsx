import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("Unhandled UI error:", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div style={{ fontFamily: "system-ui, sans-serif", padding: 24, color: "#111827" }}>
        <h1 style={{ marginBottom: 12, fontSize: 20 }}>UI error detected</h1>
        <p style={{ marginBottom: 10 }}>
          The app failed to render. Open browser devtools and check the console for details.
        </p>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "#f3f4f6",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            padding: 12,
            fontSize: 12,
          }}
        >
          {this.state.error?.message || "Unknown render error"}
        </pre>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
