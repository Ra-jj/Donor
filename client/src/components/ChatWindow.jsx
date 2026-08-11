import React, { useState, useEffect, useRef } from 'react';
import { getSocket } from '../lib/socket';
import { axiosInstance } from '../lib/axios';
import toast from 'react-hot-toast';

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
    return <div className="flex justify-center p-8"><span className="loading loading-spinner loading-md"></span></div>;
  }

  return (
    <div className="flex flex-col h-125 border border-base-300 rounded-xl bg-base-100 shadow-xl overflow-hidden">
      {/* Header */}
      <div className="bg-primary text-primary-content p-4 font-bold text-lg">
        Request Coordination Chat
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-base-200">
        {messages.length === 0 ? (
          <div className="text-center text-base-content/50 my-auto h-full flex items-center justify-center">
            No messages yet. Send a message to coordinate!
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.senderId === currentUserId;
            return (
              <div key={msg._id} className={`chat ${isMe ? 'chat-end' : 'chat-start'}`}>
                <div className={`chat-bubble ${isMe ? 'chat-bubble-primary' : 'chat-bubble-secondary'}`}>
                  {msg.text}
                </div>
                <div className="chat-footer opacity-50 text-xs mt-1">
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <form onSubmit={handleSendMessage} className="p-4 bg-base-100 border-t border-base-300 flex gap-2">
        <input
          type="text"
          placeholder="Type your message..."
          className="input input-bordered flex-1"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
};

export default ChatWindow;
