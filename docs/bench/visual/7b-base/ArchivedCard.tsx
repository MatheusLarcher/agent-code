import React, { useState } from 'react';

interface ConversaArquivada {
  id: string;
  title: string;
  updatedAt: number;
}

interface Props {
  conversations: ConversaArquivada[];
  onUnarchive: (id: string) => void;
}

export default function ArchivedCard(props: Props): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div style={styles.container}>
      <header
        onClick={() => setIsOpen(!isOpen)}
        style={{ ...styles.header, transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
      >
        Arquivadas ({props.conversations.length})
      </header>
      {isOpen && (
        <ul style={styles.list}>
          {props.conversations.map((conversation) => (
            <li key={conversation.id} style={styles.item}>
              <span>{conversation.title}</span>
              <button
                title="Desarquivar"
                onClick={() => props.onUnarchive(conversation.id)}
                style={styles.unarchiveButton}
              >
                Desarquivar
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const styles = {
  container: {
    position: 'relative',
    width: '100%',
    backdropFilter: 'blur(8px) brightness(0.7)',
    borderRadius: 'var(--radius)',
    overflow: 'hidden',
    borderImageSource: `linear-gradient(to right, var(--accent), var(--bg-2))`,
    borderImageSlice: 1,
    mask: 'radial-gradient(circle at top left, transparent 5%, white 5%)',
    maskComposite: 'source-over',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px',
    backgroundColor: 'var(--bg-3)',
    cursor: 'pointer',
    transition: 'transform 0.3s ease-in-out',
  },
  list: {
    display: 'grid',
    gridTemplateRows: isOpen ? '1fr' : '0fr',
    transition: 'grid-template-rows 0.3s ease-in-out',
    padding: '0 12px',
  },
  item: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 0',
    borderBottom: `1px solid var(--line)`,
    transition: 'opacity 0.3s ease-in-out',
  },
  unarchiveButton: {
    opacity: 0,
    transition: 'opacity 0.3s ease-in-out',
    '&:hover': {
      opacity: 1,
    },
  },
};
