const Message = require('../models/message.model');
const Request = require('../models/request.model');
const { io } = require('../lib/socket');

exports.getMessages = async (req, res) => {
  try {
    const { requestId } = req.params;
    const userId = req.user._id;

    // 1. Validate request and permissions
    const request = await Request.findById(requestId);
    
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    if (request.status !== 'accepted') {
      return res.status(403).json({ message: 'Chat is only available for accepted requests' });
    }

    const isRequester = request.requesterId.toString() === userId.toString();
    const isDonor = request.matchedDonorId && request.matchedDonorId.toString() === userId.toString();

    if (!isRequester && !isDonor) {
      return res.status(403).json({ message: 'Not authorized to view this chat' });
    }

    // 2. Fetch message history for this specific request
    const messages = await Message.find({ requestId }).sort({ createdAt: 1 });

    res.status(200).json({ messages });
  } catch (error) {
    console.error('Error in getMessages:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { text } = req.body;
    const senderId = req.user._id;

    if (!text) {
      return res.status(400).json({ message: 'Message text is required' });
    }

    // 1. Validate request and permissions
    const request = await Request.findById(requestId);
    
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    if (request.status !== 'accepted') {
      return res.status(403).json({ message: 'Chat is only available for accepted requests' });
    }

    const isRequester = request.requesterId.toString() === senderId.toString();
    const isDonor = request.matchedDonorId && request.matchedDonorId.toString() === senderId.toString();

    if (!isRequester && !isDonor) {
      return res.status(403).json({ message: 'Not authorized to send messages in this chat' });
    }

    // Determine receiverId (if sender is requester, receiver is donor, and vice versa)
    const receiverId = isRequester ? request.matchedDonorId : request.requesterId;

    // 2. Create the message
    const newMessage = new Message({
      senderId,
      receiverId,
      requestId,
      text,
    });

    await newMessage.save();

    // 3. Emit via socket to the receiver in real time
    io.to(receiverId.toString()).emit('newMessage', newMessage);

    res.status(201).json({ message: 'Message sent successfully', newMessage });
  } catch (error) {
    console.error('Error in sendMessage:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
