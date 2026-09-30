const Message = require('../models/message.model');
const Request = require('../models/request.model');
const User = require('../models/user.model');
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

    // 2. Fetch message history for this specific request, between its requester and its current
    // donor only. A request goes back to pending when its donor deletes their account, and the
    // next donor must never see a message meant for the one before.
    const messages = await Message.find({
      requestId,
      $or: [
        { senderId: request.requesterId, receiverId: request.matchedDonorId },
        { senderId: request.matchedDonorId, receiverId: request.requesterId },
      ],
    }).sort({ createdAt: 1 });

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

    // protectRoute found the sender, but their account deletion (deleteAccount in
    // user.controller.js) can commit before this save lands, and after its own clean-up has run.
    // Checked after the write: a check that runs before the commit still sees the sender, and
    // then that clean-up, which starts after the commit, removes the message instead. The
    // receiver has not been sent it yet.
    if (!(await User.exists({ _id: senderId }))) {
      await Message.deleteOne({ _id: newMessage._id });
      console.warn(`sendMessage: sender ${senderId} no longer exists, so message ${newMessage._id} was removed again`);
      return res.status(401).json({ message: 'Unauthorized - User not found' });
    }

    // The receiver's account deletion can land the same way. It puts the request back to pending
    // (or deletes it) and erases their messages, but a message saved after that clean-up would
    // stay, with their id, on a request the next donor can accept. Checked after the write for the
    // same reason as above; the user check also covers an accept by a deleted donor that has not
    // been undone yet.
    const isChatStillOpen =
      (await Request.exists({
        _id: requestId,
        status: 'accepted',
        requesterId: request.requesterId,
        matchedDonorId: request.matchedDonorId,
      })) && (await User.exists({ _id: receiverId }));
    if (!isChatStillOpen) {
      await Message.deleteOne({ _id: newMessage._id });
      console.warn(`sendMessage: the chat on request ${requestId} ended before message ${newMessage._id} was saved, so it was removed again`);
      return res.status(409).json({ message: 'This chat has ended' });
    }

    // 3. Emit via socket to the receiver in real time
    io.to(receiverId.toString()).emit('newMessage', newMessage);

    res.status(201).json({ message: 'Message sent successfully', newMessage });
  } catch (error) {
    console.error('Error in sendMessage:', error.message);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
