import { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { getSocket, hasSocketConnectedBefore, hadFailedAttempt } from '../lib/socket';
import { axiosInstance } from '../lib/axios';
import toast from 'react-hot-toast';
import { PaperPlaneRight, ChatCircleDots } from '@phosphor-icons/react';

const ChatWindow = ({ requestId, currentUserId }) => {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef(null);

  // Auto-scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Fetch initial message history
  useEffect(() => {
    const fetchMessages = async () => {
      setLoading(true);
      try {
        const response = await axiosInstance.get(`/messages/${requestId}`);
        setMessages(response.data.messages);
      } catch (error) {
        console.error('Error fetching messages:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchMessages();
  }, [requestId]);

  // Listen for real-time incoming messages
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleNewMessage = (newMessage) => {
      // Only append if the message belongs to this specific chat request
      if (newMessage.requestId === requestId) {
        // Skip it if a reconnect refetch already added this message
        setMessages((prev) => (prev.some((m) => m._id === newMessage._id) ? prev : [...prev, newMessage]));
      }
    };

    // Messages sent while offline are not replayed, so refetch quietly on every connect after
    // this socket's first ('connect' also follows the manual retries in lib/socket.js, which
    // fire no 'reconnect'). Keep local messages the server list lacks (an unsent optimistic
    // one has a temporary _id). The draft in the input is separate state and is not touched.
    let isCurrent = true;
    let hasConnectedBefore = hasSocketConnectedBefore(socket);
    // A first connect that followed failed attempts also refetches (see DashboardPage)
    const handleConnect = () => {
      const shouldRefetch = hasConnectedBefore || hadFailedAttempt(socket);
      hasConnectedBefore = true;
      if (!shouldRefetch) return;
      axiosInstance
        .get(`/messages/${requestId}`)
        .then((response) => {
          if (!isCurrent) return; // the chat switched to another request meanwhile
          const serverMessages = response.data.messages;
          setMessages((prev) => {
            const serverIds = new Set(serverMessages.map((msg) => msg._id));
            return [...serverMessages, ...prev.filter((msg) => !serverIds.has(msg._id))];
          });
        })
        .catch(() => {});
    };

    socket.on('newMessage', handleNewMessage);
    socket.on('connect', handleConnect);

    return () => {
      isCurrent = false;
      socket.off('newMessage', handleNewMessage);
      socket.off('connect', handleConnect);
    };
  }, [requestId]);

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;

    // 1. Optimistic UI Update (immediate feedback for better UX)
    const optimisticMessage = {
      _id: Date.now().toString(),
      senderId: currentUserId,
      requestId,
      text: text.trim(),
      createdAt: new Date().toISOString(),
    };
    
    setMessages((prev) => [...prev, optimisticMessage]);
    const messageToSend = text.trim();
    setText(''); // clear input immediately

    // 2. Actually send to server
    try {
      const response = await axiosInstance.post(`/messages/send/${requestId}`, { text: messageToSend });
      // Swap in the saved message so its real _id lets a reconnect refetch dedupe it.
      // If a refetch already brought it in, just drop the optimistic copy.
      const savedMessage = response.data.newMessage;
      if (savedMessage && savedMessage._id) {
        setMessages((prev) => (prev.some((msg) => msg._id === savedMessage._id)
          ? prev.filter((msg) => msg._id !== optimisticMessage._id)
          : prev.map((msg) => (msg._id === optimisticMessage._id ? savedMessage : msg))));
      }
    } catch (error) {
      console.error('Error sending message:', error);
      toast.error('Failed to send message');
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center p-8 mt-12">
        <span className="loading loading-spinner loading-lg text-primary"></span>
      </div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35 }}
      className="flex flex-col h-[calc(100vh-140px)] lg:h-125 border border-base-300 rounded-3xl bg-base-100 shadow-xl overflow-hidden shadow-base-content/5"
    >
      {/* Header */}
      <div className="bg-primary/5 border-b border-primary/10 text-base-content p-4 font-bold flex items-center gap-3">
        <div className="bg-primary/20 text-primary p-2 rounded-full">
          <ChatCircleDots weight="fill" className="w-6 h-6" />
        </div>
        <span className="font-display text-lg tracking-tight">Coordination Chat</span>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-base-100/50">
        {messages.length === 0 ? (
          <div className="text-center text-base-content/40 my-auto h-full flex flex-col items-center justify-center font-medium">
            <ChatCircleDots weight="duotone" className="w-10 h-10 mb-3 text-base-content/15" />
            <p className="text-sm">No messages yet.<br/>Send a message to coordinate!</p>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isMe = msg.senderId === currentUserId;
            return (
              <motion.div 
                key={msg._id} 
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: index > messages.length - 3 ? 0.05 : 0 }}
                className={`chat ${isMe ? 'chat-end' : 'chat-start'}`}
              >
                <div className={`chat-bubble font-medium shadow-sm ${isMe ? 'chat-bubble-primary text-white' : 'bg-base-200 text-base-content'}`}>
                  {msg.text}
                </div>
                <div className="chat-footer opacity-40 text-xs mt-1 font-medium">
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                </div>
              </motion.div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <form onSubmit={handleSendMessage} className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-base-100 border-t border-base-200 flex gap-3">
        <input
          type="text"
          placeholder="Type your message..."
          className="input w-full pl-4 rounded-2xl border border-base-300 bg-base-100 shadow-sm focus:border-primary focus:ring-1 focus:ring-primary transition-all font-medium flex-1 text-base"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <motion.button 
          type="submit" 
          className="btn btn-primary btn-circle shadow-lg shadow-primary/20 border-none" 
          disabled={!text.trim()}
          whileTap={{ scale: 0.92 }}
          transition={{ duration: 0.1 }}
        >
          <PaperPlaneRight weight="fill" className="w-5 h-5 text-white" />
        </motion.button>
      </form>
    </motion.div>
  );
};

export default ChatWindow;
