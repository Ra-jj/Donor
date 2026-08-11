import React from 'react';
import { Link } from 'react-router-dom';
import { Droplet, LogOut } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';

const Navbar = () => {
  const { authUser, logout } = useAuthStore();

  return (
    <div className="navbar bg-base-100 shadow-sm px-4 md:px-8">
      <div className="flex-1">
        <Link to="/" className="btn btn-ghost normal-case text-xl font-bold flex items-center gap-2">
          <Droplet className="w-6 h-6 text-red-500 fill-current" />
          <span className="text-primary">Donor</span>
        </Link>
      </div>
      <div className="flex-none gap-2">
        {authUser ? (
          <>
            <div className="dropdown dropdown-end">
              <label tabIndex={0} className="btn btn-ghost btn-circle avatar">
                <div className="w-10 rounded-full bg-primary/20 text-primary flex items-center justify-center font-bold">
                  {authUser?.name?.charAt(0)?.toUpperCase() || 'U'}
                </div>
              </label>
              <ul tabIndex={0} className="mt-3 z-1 p-2 shadow menu menu-sm dropdown-content bg-base-100 rounded-box w-52">
                <li className="menu-title px-4 py-2 opacity-50">
                  {authUser?.email || 'User'}
                </li>
                <li>
                  <button onClick={logout} className="text-error hover:bg-error/10 flex gap-2">
                    <LogOut className="w-4 h-4" />
                    Logout
                  </button>
                </li>
              </ul>
            </div>
          </>
        ) : (
          <div className="flex gap-2">
            <Link to="/login" className="btn btn-ghost">Login</Link>
            <Link to="/register" className="btn btn-primary">Sign Up</Link>
          </div>
        )}
      </div>
    </div>
  );
};

export default Navbar;
