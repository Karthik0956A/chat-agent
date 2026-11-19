import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const lang = match ? match[1] : '';
  const rawCode = String(children).replace(/\n$/, '');

  const handleCopy = () => {
    navigator.clipboard.writeText(rawCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{
      margin: '12px 0',
      borderRadius: '8px',
      overflow: 'hidden',
      backgroundColor: '#0a0d14',
      border: '1px solid #232a3a',
      fontSize: '13px'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 12px',
        backgroundColor: '#131822',
        borderBottom: '1px solid #1f2635',
        color: '#94a3b8',
        fontSize: '11px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.5px'
      }}>
        <span>{lang || 'code'}</span>
        <button
          onClick={handleCopy}
          style={{
            background: 'transparent',
            border: 'none',
            color: copied ? '#4ade80' : '#94a3b8',
            cursor: 'pointer',
            fontSize: '11px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 6px',
            borderRadius: '4px',
            transition: 'color 0.2s'
          }}
        >
          {copied ? '✓ Copied' : '📋 Copy'}
        </button>
      </div>
      <pre style={{
        padding: '12px 14px',
        margin: 0,
        overflowX: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        color: '#e2e8f0',
        lineHeight: 1.55
      }}>
        <code>{rawCode}</code>
      </pre>
    </div>
  );
}

// Transform citation numbers like [1], [2], [1, 2] into sleek pill badges
function formatCitations(text: string): React.ReactNode {
  const parts = text.split(/(\[\d+(?:,\s*\d+)*\])/g);
  if (parts.length === 1) return text;

  return parts.map((part, idx) => {
    if (/^\[\d+(?:,\s*\d+)*\]$/.test(part)) {
      return (
        <span
          key={idx}
          style={{
            display: 'inline-block',
            padding: '1px 5px',
            margin: '0 2px',
            borderRadius: '4px',
            backgroundColor: '#242b3d',
            color: '#a5b4fc',
            fontSize: '11px',
            fontWeight: 600,
            verticalAlign: 'baseline',
            border: '1px solid #36415a'
          }}
        >
          {part}
        </span>
      );
    }
    return part;
  });
}

export default function MarkdownMessage({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  // Strip hidden <FACTS> block from user-facing markdown if present
  const cleanContent = content.replace(/<FACTS>[\s\S]*?<\/FACTS>/g, '').trim();

  return (
    <div className="markdown-content" style={{ color: '#f1f5f9', lineHeight: 1.65, fontSize: '14px' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 style={{
              fontSize: '20px',
              fontWeight: 700,
              margin: '18px 0 10px',
              color: '#f8fafc',
              borderBottom: '1px solid #232a3a',
              paddingBottom: '6px'
            }}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 style={{
              fontSize: '17px',
              fontWeight: 600,
              margin: '14px 0 8px',
              color: '#f1f5f9'
            }}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 style={{
              fontSize: '15px',
              fontWeight: 600,
              margin: '12px 0 6px',
              color: '#e2e8f0'
            }}>
              {children}
            </h3>
          ),
          p: ({ children }) => {
            // Process strings for citation pill rendering
            const processed = React.Children.map(children, (child) => {
              if (typeof child === 'string') return formatCitations(child);
              return child;
            });
            return <p style={{ margin: '8px 0', lineHeight: 1.65 }}>{processed}</p>;
          },
          ul: ({ children }) => (
            <ul style={{ margin: '8px 0', paddingLeft: '22px', listStyleType: 'disc' }}>
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol style={{ margin: '8px 0', paddingLeft: '22px', listStyleType: 'decimal' }}>
              {children}
            </ol>
          ),
          li: ({ children }) => {
            const processed = React.Children.map(children, (child) => {
              if (typeof child === 'string') return formatCitations(child);
              return child;
            });
            return <li style={{ margin: '4px 0', lineHeight: 1.6 }}>{processed}</li>;
          },
          blockquote: ({ children }) => (
            <blockquote style={{
              borderLeft: '3px solid #6366f1',
              paddingLeft: '14px',
              margin: '12px 0',
              color: '#94a3b8',
              fontStyle: 'italic',
              backgroundColor: '#11151f',
              padding: '8px 14px',
              borderRadius: '0 6px 6px 0'
            }}>
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', margin: '12px 0', borderRadius: '8px', border: '1px solid #232a3a' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th style={{
              backgroundColor: '#181e2b',
              borderBottom: '1px solid #273145',
              padding: '10px 14px',
              textAlign: 'left',
              fontWeight: 600,
              color: '#f8fafc'
            }}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td style={{
              borderBottom: '1px solid #1c2230',
              padding: '9px 14px',
              color: '#cbd5e1'
            }}>
              {children}
            </td>
          ),
          hr: () => (
            <hr style={{ border: 'none', borderTop: '1px solid #232a3a', margin: '16px 0' }} />
          ),
          strong: ({ children }) => (
            <strong style={{ color: '#f8fafc', fontWeight: 600 }}>{children}</strong>
          ),
          em: ({ children }) => (
            <em style={{ color: '#e2e8f0', fontStyle: 'italic' }}>{children}</em>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: '#818cf8',
                textDecoration: 'none',
                fontWeight: 500,
                borderBottom: '1px solid rgba(129, 140, 248, 0.4)'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderBottom = '1px solid #818cf8')}
              onMouseLeave={(e) => (e.currentTarget.style.borderBottom = '1px solid rgba(129, 140, 248, 0.4)')}
            >
              {children}
            </a>
          ),
          code: ({ className, children, ...props }) => {
            const isBlock = !!className || String(children).includes('\n');
            if (isBlock) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            return (
              <code
                style={{
                  backgroundColor: '#1e2433',
                  color: '#e0e7ff',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontSize: '12.5px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  border: '1px solid #2d364a'
                }}
                {...props}
              >
                {children}
              </code>
            );
          }
        }}
      >
        {cleanContent}
      </ReactMarkdown>
      {isStreaming && (
        <span style={{
          display: 'inline-block',
          width: '7px',
          height: '14px',
          backgroundColor: '#818cf8',
          marginLeft: '4px',
          verticalAlign: 'middle',
          borderRadius: '1px',
          animation: 'pulse 1s infinite'
        }} />
      )}
    </div>
  );
}
