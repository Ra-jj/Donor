import React, { useState, useEffect, useRef } from 'react';
import { getSocket } from '../lib/socket';
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
        setMessages((prev) => [...prev, newMessage]);
      }
    };

    socket.on('newMessage', handleNewMessage);

    return () => {
      socket.off('newMessage', handleNewMessage);
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
      await axiosInstance.post(`/messages/send/${requestId}`, { text: messageToSend });
    } catch (error) {
      console.error('Error sending message:', error);
      toast.error('Failed to send message');
    }
  };

  if (loading) {
    return <div className="flex justify-center p-8 mt-12"><span className="loading loading-spinner loading-lg text-primary"></span></div>;
  }

  return (
    <div className="flex flex-col h-125 border border-base-300 rounded-3xl bg-base-100 shadow-xl overflow-hidden shadow-base-content/5">
      {/* Header */}
      <div className="bg-primary/5 border-b border-primary/10 text-base-content p-4 font-bold flex items-center gap-3">
        <div className="bg-primary/20 text-primary p-2 rounded-full">
          <ChatCircleDots weight="fill" className="w-6 h-6" />
        </div>
        <span className="font-display text-lg tracking-tight">Request Coordination Chat</span>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-base-100/50">
        {messages.length === 0 ? (
          <div className="text-center text-base-content/50 my-auto h-full flex flex-col items-center justify-center font-medium">
            <ChatCircleDots weight="duotone" className="w-12 h-12 mb-3 text-base-content/20" />
            No messages yet.<br/>Send a message to coordinate!
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.senderId === currentUserId;
            return (
              <div key={msg._id} className={`chat ${isMe ? 'chat-end' : 'chat-start'}`}>
                <div className={`chat-bubble font-medium shadow-sm ${isMe ? 'chat-bubble-primary text-white' : 'bg-base-200 text-base-content'}`}>
                  {msg.text}
                </div>
                <div className="chat-footer opacity-60 text-xs mt-1 font-semibold">
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <form onSubmit={handleSendMessage} className="p-4 bg-base-100 border-t border-base-200 flex gap-3">
        <input
          type="text"
          placeholder="Type your message..."
          className="input w-full pl-4 rounded-2xl border border-base-300 bg-base-100 shadow-sm focus:border-primary focus:ring-1 focus:ring-primary transition-all font-medium flex-1"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn btn-primary btn-circle shadow-lg shadow-primary/20 border-none" disabled={!text.trim()}>
          <PaperPlaneRight weight="fill" className="w-5 h-5 text-white" />
        </button>
      </form>
    </div>
  );
};

export default ChatWindow;
